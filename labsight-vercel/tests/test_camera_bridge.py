"""Run: python -m unittest discover -s labsight-vercel/tests -p 'test_*.py'"""
import asyncio
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription, VideoStreamTrack, AudioStreamTrack

spec = importlib.util.spec_from_file_location('bridge', pathlib.Path(__file__).parents[1] / 'tools/recamera_webrtc_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class FakePlayer:
    def __init__(self):
        self.video = VideoStreamTrack()
        self.audio = AudioStreamTrack()


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Make transport tests deterministic and independent of host NIC enumeration.
        self.addresses = patch('aioice.ice.get_host_addresses', return_value=['127.0.0.1'])
        self.addresses.start()
        self.addCleanup(self.addresses.stop)
        self.client = TestClient(TestServer(bridge.create_app()))
        await self.client.start_server()
        self.pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))

    async def asyncTearDown(self):
        await self.pc.close()
        await self.client.close()
        self.assertEqual(len(bridge.pcs), 0)
        self.assertEqual(len(bridge.players), 0)
        self.assertEqual(len(bridge.audio_sinks), 0)

    async def make_offer(self):
        self.pc.addTransceiver('video', direction='recvonly')
        await self.pc.setLocalDescription(await self.pc.createOffer())
        return dict(sdp=self.pc.localDescription.sdp, type='offer', camera_ip='192.168.1.100',
                    username='camera', password='secret@:/测试', rtsp_path='/stream1')

    async def test_url_credentials_and_profiles(self):
        url = bridge.make_rtsp('192.168.1.100','camera','secret@:/测试','/stream1')
        self.assertIn('secret%40%3A%2F%E6%B5%8B%E8%AF%95',url)
        self.assertTrue(url.endswith(':554/stream1'))
        self.assertTrue(bridge.make_rtsp('192.168.42.1','admin','', '/main').endswith('/main'))
        self.assertTrue(bridge.make_rtsp('::1','','', 'stream2').endswith('[::1]:554/stream2'))
        for host in ['http://camera', '192.168.1.1:554', 'foo@192.168.1.1']:
            with self.assertRaises(ValueError): bridge.make_rtsp(host,'','')

    async def test_invalid_offer_no_leak_and_cors(self):
        response = await self.client.post('/offer',json={'type':'answer'})
        self.assertEqual(response.status,400)
        self.assertEqual(len(bridge.pcs),0)
        response = await self.client.options('/offer',headers={'Origin':'https://labsight.example'})
        self.assertEqual(response.status,204)
        self.assertEqual(response.headers['Access-Control-Allow-Private-Network'],'true')

    async def test_failure_does_not_echo_password(self):
        data = await self.make_offer()
        with patch.object(bridge,'open_player',side_effect=RuntimeError('rtsp://camera:secret@192.168.1.100')):
            response = await self.client.post('/offer',json=data)
        self.assertEqual(response.status,502)
        self.assertNotIn('secret',await response.text())
        self.assertEqual(len(bridge.pcs),0)

    async def test_video_frames_and_cleanup(self):
        data = await self.make_offer()
        player = FakePlayer()
        track_ready = asyncio.Future()
        @self.pc.on('track')
        def on_track(track):
            if not track_ready.done(): track_ready.set_result(track)
        with patch.object(bridge,'open_player',return_value=player):
            response = await self.client.post('/offer',json=data)
        self.assertEqual(response.status,200)
        answer = await response.json()
        await self.pc.setRemoteDescription(RTCSessionDescription(**answer))
        track = await asyncio.wait_for(track_ready,5)
        frame = await asyncio.wait_for(track.recv(),8)
        self.assertEqual((frame.width,frame.height),(640,480))
        for pc in list(bridge.pcs): await bridge.close_peer(pc)
        self.assertEqual(player.video.readyState,'ended')
        self.assertEqual(player.audio.readyState,'ended')

    async def test_slow_camera_does_not_block_health(self):
        import time
        data = await self.make_offer()
        def slow_open(url):
            time.sleep(.4)
            raise RuntimeError('offline')
        with patch.object(bridge,'open_player',side_effect=slow_open):
            task=asyncio.create_task(self.client.post('/offer',json=data))
            await asyncio.sleep(.1)
            response=await asyncio.wait_for(self.client.get('/health'),.2)
            self.assertEqual(response.status,200)
            self.assertEqual((await task).status,502)


if __name__ == '__main__': unittest.main()
