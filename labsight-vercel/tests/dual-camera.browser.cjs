/* Run with Playwright installed: node labsight-vercel/tests/dual-camera.browser.cjs
 * Optional PLAYWRIGHT_MODULE and CHROMIUM_PATH select an existing test runtime.
 * Transport is mocked; native canvas video/capture is exercised in Chromium.
 * No real camera, microphone or AI service is contacted.
 */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
(async () => {
  const server = http.createServer((req,res) => {
    const file = path.join(root,req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(root + '/') || !fs.existsSync(file)) {res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || undefined,args:['--no-sandbox']});
  try {
    const page=await browser.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const dialogs=[];page.on('dialog',async d=>{dialogs.push(d.message());await d.dismiss();});
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin) return route.fulfill({status:200,body:''});
      if(url.pathname.startsWith('/api/')) return route.fulfill({json:url.pathname==='/api/analyze'?{provider:'gemini',model:'mock',answer:'test answer'}:{ok:true,providers:{}}});
      // Exercise the complete local page; external RTC/model libraries are not loaded.
      return route.continue();
    });
    await page.addInitScript(()=>{
      window.requests=[]; window.analysisRequests=[]; window.peers=[]; window.fakeMode='ok'; window.usbStreams=[];
      const realFetch=window.fetch.bind(window);
      function makeVideo(color,deviceId) {
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
        const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,640,480);
        const stream=canvas.captureStream(20);
        const timer=setInterval(()=>{ctx.fillStyle=color;ctx.fillRect(0,0,640,480);},30);
        window.usbStreams.push({stream,timer});
        const track=stream.getVideoTracks()[0];track.getSettings=()=>({width:640,height:480,deviceId});
        return stream;
      }
      Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async constraints=>{
        if(constraints.video)return makeVideo('#d02020',constraints.video.deviceId?.exact||'usb-pcb');
        if(window.denyMic)throw new DOMException('denied','NotAllowedError');
        const audio=new AudioContext();window.testAudio=audio;return audio.createMediaStreamDestination().stream;
      }});
      Object.defineProperty(navigator.mediaDevices,'enumerateDevices',{value:async()=>[
        {kind:'videoinput',deviceId:'usb-pcb',label:'PCB USB'}, {kind:'videoinput',deviceId:'usb-other',label:'Other USB'}, {kind:'audioinput',deviceId:'mic',label:'Test mic'}
      ]});
      window.RTCPeerConnection=class {
        constructor(){this.connectionState='new';this.iceGatheringState='complete';window.peers.push(this);}
        addTransceiver(){}
        async createOffer(){return {sdp:'test-offer',type:'offer'};}
        async setLocalDescription(d){this.localDescription=d;}
        async setRemoteDescription(){
          const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
          const ctx=canvas.getContext('2d');let count=0;
          this.timer=setInterval(()=>{ctx.fillStyle='#20aa60';ctx.fillRect(0,0,640,480);},30);
          this.stream=canvas.captureStream(20);
          this.connectionState='connected';
          this.ontrack?.({track:this.stream.getVideoTracks()[0]});
          this.onconnectionstatechange?.();
        }
        close(){this.connectionState='closed';clearInterval(this.timer);this.stream?.getTracks().forEach(t=>t.stop());this.onconnectionstatechange?.();}
      };
      window.fetch=async(url,opts={})=>{
        if(String(url).includes('/api/analyze'))window.analysisRequests.push(JSON.parse(opts.body));
        if(!String(url).startsWith('http://127.0.0.1:18765'))return realFetch(url,opts);
        if(String(url).includes('/health')) return new Response(JSON.stringify({ok:true}));
        const body=JSON.parse(opts.body);window.requests.push(body);
        if(window.fakeMode==='wait')return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
        if(window.fakeMode==='error')return new Response(JSON.stringify({error:'rtsp://user:DO_NOT_DISPLAY@ip'}),{status:502});
        return new Response(JSON.stringify({type:'answer',sdp:'test-answer'}));
      };
    });
    await page.goto(origin);
    await page.waitForSelector('#instrument-cameraSourceSelect');
    await page.evaluate(()=>{els.autoSpeak.checked=false;});
    assert.equal(await page.inputValue('#instrument-cameraSourceSelect'),'tapo');
    await page.selectOption('#cameraSelect','usb-pcb');
    await page.click('#startCamera');
    await page.waitForFunction(()=>document.querySelector('#video').videoWidth===640);
    await page.fill('#instrument-recameraIp','192.168.1.100');
    await page.fill('#instrument-recameraUser','camera-user');
    await page.fill('#instrument-recameraPassword','instrument-password');
    await page.click('#instrumentStartCamera');
    await page.waitForFunction(()=>document.querySelector('#instrumentViewerBadge').textContent==='Tapo C113 LIVE');
    assert.equal(await page.evaluate(()=>state.stream.getVideoTracks()[0].readyState),'live');
    const micId=await page.evaluate(()=>state.stream.getAudioTracks()[0].id);
    const primaryId=await page.evaluate(()=>state.stream.getVideoTracks()[0].id);
    assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('instrument-password')),false);
    await page.selectOption('#cameraAnalysisTarget','both');
    await page.fill('#question','结合PCB和仪器读数分析');
    await page.click('#sendBtn');
    await page.waitForFunction(()=>analysisRequests.length===1);
    let request=await page.evaluate(()=>analysisRequests[0]);
    assert.deepEqual(request.camera_frames.map(f=>f.role),['pcb','instrument']);assert.equal(request.scene,'dual');
    // Native JPEGs must carry distinct cameras, rather than duplicating #video.
    const colors=await page.evaluate(async()=>Promise.all(analysisRequests[0].camera_frames.map(async f=>{
      const image=new Image();image.src=f.image_data_url;await image.decode();const c=document.createElement('canvas');c.width=c.height=1;
      const x=c.getContext('2d');x.drawImage(image,0,0,1,1);return [...x.getImageData(0,0,1,1).data];
    })));
    assert(colors[0][0]>colors[0][1]*2);assert(colors[1][1]>colors[1][0]*2);
    assert.equal(await page.evaluate(()=>getNativeFrameCanvas().getContext('2d').getImageData(20,20,1,1).data[0]>150),true);
    await page.selectOption('#cameraAnalysisTarget','instrument');
    await page.click('#sendBtn');await page.waitForFunction(()=>analysisRequests.length===2);
    assert.deepEqual(await page.evaluate(()=>analysisRequests[1].camera_frames.map(f=>f.role)),['instrument']);
    await page.click('#instrument-disconnectCamera');
    assert.equal(await page.evaluate(()=>state.stream.getVideoTracks()[0].id),primaryId);
    assert.equal(await page.evaluate(()=>state.stream.getAudioTracks()[0].id),micId);
    assert.equal(await page.evaluate(()=>state.stream.getAudioTracks()[0].readyState),'live');
    await page.selectOption('#cameraAnalysisTarget','both');
    await page.click('#sendBtn');
    assert.equal(await page.evaluate(()=>analysisRequests.length),2);assert(dialogs.pop().includes('尚未连接'));
    assert.equal(await page.evaluate(()=>state.lastCameraFrames.length),0);
    await page.selectOption('#cameraAnalysisTarget','auto');await page.click('#sendBtn');
    await page.waitForFunction(()=>analysisRequests.length===3);
    assert.deepEqual(await page.evaluate(()=>analysisRequests[2].camera_frames.map(f=>f.role)),['pcb']);
    await page.click('#instrumentStartCamera');
    await page.waitForFunction(()=>document.querySelector('#instrumentViewerBadge').textContent==='Tapo C113 LIVE'&&document.querySelector('#instrumentVideo').videoWidth===640);
    const instrumentId=await page.evaluate(()=>LabSightDualCamera.slots()[1].stream.getVideoTracks()[0].id);
    await page.click('#disconnectCamera');
    assert.equal(await page.evaluate(()=>LabSightDualCamera.slots()[1].stream.getVideoTracks()[0].id),instrumentId);
    assert.equal(await page.evaluate(()=>LabSightDualCamera.slots()[1].stream.getVideoTracks()[0].readyState),'live');
    await page.click('#sendBtn');await page.waitForFunction(()=>analysisRequests.length===4);
    assert.deepEqual(await page.evaluate(()=>analysisRequests[3].camera_frames.map(f=>f.role)),['instrument']);
    await page.click('#connectSharedMic');await page.waitForFunction(()=>state.stream?.getAudioTracks().length===1);
    assert.equal(await page.evaluate(()=>state.stream.getVideoTracks().length),0);
    await page.selectOption('#instrument-cameraSourceSelect','uvc');
    await page.selectOption('#instrumentCameraSelect','usb-other');
    await page.click('#instrumentStartCamera');await page.waitForFunction(()=>document.querySelector('#instrumentVideo').videoWidth===640);
    assert.equal(await page.evaluate(()=>LabSightDualCamera.slots()[1].stream.getVideoTracks()[0].getSettings().deviceId),'usb-other');
    await page.selectOption('#cameraSelect','usb-other');await page.click('#startCamera');
    assert(dialogs.pop().includes('已被另一路使用'));
    await page.selectOption('#cameraSelect','usb-pcb');await page.click('#startCamera');
    await page.waitForFunction(()=>document.querySelector('#video').videoWidth===640);
    await page.setViewportSize({width:1440,height:1050});
    await page.screenshot({path:process.env.DUAL_SCREENSHOT || '/tmp/labsight-dual-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>document.querySelector('.dual-camera-grid').scrollWidth<=document.querySelector('.dual-camera-grid').clientWidth+1));
    await page.screenshot({path:'/tmp/labsight-dual-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
    await page.evaluate(()=>{LabSightCameraAdapters.disconnectCamera();LabSightDualCamera.instrument.disconnectCamera();peers.forEach(pc=>pc.close());usbStreams.forEach(s=>{clearInterval(s.timer);s.stream.getTracks().forEach(t=>t.stop());});testAudio?.close();});
    console.log('PASS: two independent cameras, distinct labeled JPEGs, multi-image analyze requests, one-camera fallback, no stale frames, disconnect isolation, shared mic, USB conflict, PCB canvas isolation, desktop/mobile layout.');
  } finally {await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
