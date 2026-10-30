"""Camera-role routing and multi-image provider payloads; no external API calls."""
import pathlib
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
from api import analyze as api
from fastapi import HTTPException
from pydantic import ValidationError

PCB = 'data:image/jpeg;base64,cGNi'
INSTRUMENT = 'data:image/jpeg;base64,aW5zdHJ1bWVudA=='


def request(**changes):
    fields = dict(image_data_url=PCB, camera_frames=[
        dict(role='pcb', image_data_url=PCB, captured_at='2026-10-30T10:00:00Z'),
        dict(role='instrument', image_data_url=INSTRUMENT, captured_at='2026-10-30T10:00:00.010Z'),
    ])
    return api.AnalyzeRequest(**(fields | changes))


class DualCameraApiTests(unittest.TestCase):
    def test_legacy_single_image_compatible(self):
        self.assertEqual(api._image_items(request(camera_frames=[])), [('来源：当前摄像头', PCB)])

    def test_labels_roles_and_times_stay_with_distinct_images(self):
        items = api._image_items(request())
        self.assertIn('PCB 摄像头', items[0][0])
        self.assertIn('仪器摄像头', items[1][0])
        self.assertIn('10:00:00.010000', items[1][0])
        self.assertEqual([data for _, data in items], [PCB, INSTRUMENT])
        self.assertIn('并非硬件同步', api._user_text(request()))
        instrument = request(camera_frames=[dict(role='instrument', image_data_url=INSTRUMENT)])
        self.assertIn('通用仪器', api._user_text(instrument))

    def test_role_and_count_validation(self):
        with self.assertRaises(ValidationError):
            request(camera_frames=[dict(role='unknown', image_data_url=PCB)])
        with self.assertRaises(ValidationError):
            request(camera_frames=[dict(role='pcb', image_data_url=PCB)] * 3)
        with self.assertRaises(HTTPException) as caught:
            api._image_items(request(camera_frames=[dict(role='pcb', image_data_url=PCB)] * 2))
        self.assertEqual(caught.exception.status_code, 400)

    def test_image_type_and_combined_size_validation(self):
        with self.assertRaises(HTTPException) as caught:
            api._image_items(request(camera_frames=[dict(role='pcb', image_data_url='data:text/html;base64,YQ==')]))
        self.assertEqual(caught.exception.status_code, 400)
        huge = 'data:image/jpeg;base64,' + 'a' * 1_600_000
        with self.assertRaises(HTTPException) as caught:
            api._image_items(request(camera_frames=[dict(role=role, image_data_url=huge) for role in ['pcb', 'instrument']]))
        self.assertEqual(caught.exception.status_code, 413)

    @patch.dict('os.environ', {'GEMINI_API_KEY': 'test-only'})
    @patch.object(api.requests, 'post')
    def test_gemini_receives_two_separately_labeled_images(self, post):
        post.return_value = Mock(status_code=200)
        post.return_value.json.return_value = {'candidates': [{'content': {'parts': [{'text': 'ok'}]}}]}
        self.assertEqual(api._call_gemini(request())[0], 'ok')
        parts = post.call_args.kwargs['json']['contents'][0]['parts']
        self.assertEqual(len(parts), 5)
        self.assertIn('PCB 摄像头', parts[1]['text'])
        self.assertIn('仪器摄像头', parts[3]['text'])
        self.assertEqual([p['inlineData']['data'] for p in parts if 'inlineData' in p], ['cGNi', 'aW5zdHJ1bWVudA=='])

    @patch.dict('os.environ', {'OPENAI_API_KEY': 'test-only'})
    @patch.object(api.requests, 'post')
    def test_openai_receives_two_separately_labeled_images(self, post):
        post.return_value = Mock(status_code=200)
        post.return_value.json.return_value = {'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': 'ok'}]}]}
        self.assertEqual(api._call_openai(request())[0], 'ok')
        parts = post.call_args.kwargs['json']['input'][0]['content']
        self.assertEqual(len(parts), 5)
        self.assertIn('PCB 摄像头', parts[1]['text'])
        self.assertIn('仪器摄像头', parts[3]['text'])
        self.assertEqual([p['image_url'] for p in parts if p['type'] == 'input_image'], [PCB, INSTRUMENT])


if __name__ == '__main__':
    unittest.main()
