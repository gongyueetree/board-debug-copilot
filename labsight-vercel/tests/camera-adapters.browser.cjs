/* Run with Playwright installed: node labsight-vercel/tests/camera-adapters.browser.cjs
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
      if(url.pathname.startsWith('/api/')) return route.fulfill({json:{ok:true,providers:{}}});
      if(url.pathname.endsWith('.js')&&!['/app.js','/camera-adapters.js','/imx415-uvc-profile.js'].includes(url.pathname)) return route.fulfill({body:''});
      return route.continue();
    });
    await page.addInitScript(()=>{
      window.requests=[]; window.peers=[]; window.fakeMode='ok';
      const realFetch=window.fetch.bind(window);
      const fakeMic=async()=>{throw new DOMException('denied','NotAllowedError');};
      Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:fakeMic});
      window.RTCPeerConnection=class {
        constructor(){this.connectionState='new';this.iceGatheringState='complete';window.peers.push(this);}
        addTransceiver(){}
        async createOffer(){return {sdp:'test-offer',type:'offer'};}
        async setLocalDescription(d){this.localDescription=d;}
        async setRemoteDescription(){
          const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
          const ctx=canvas.getContext('2d');let count=0;
          this.timer=setInterval(()=>{ctx.fillStyle=count++%2?'#20aa60':'#2080aa';ctx.fillRect(0,0,640,480);},30);
          this.stream=canvas.captureStream(20);
          this.connectionState='connected';
          this.ontrack?.({track:this.stream.getVideoTracks()[0]});
          this.onconnectionstatechange?.();
        }
        close(){this.connectionState='closed';clearInterval(this.timer);this.stream?.getTracks().forEach(t=>t.stop());this.onconnectionstatechange?.();}
      };
      window.fetch=async(url,opts={})=>{
        if(!String(url).startsWith('http://127.0.0.1:18765'))return realFetch(url,opts);
        if(String(url).includes('/health')) return new Response(JSON.stringify({ok:true}));
        const body=JSON.parse(opts.body);window.requests.push(body);
        if(window.fakeMode==='wait')return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
        if(window.fakeMode==='error')return new Response(JSON.stringify({error:'rtsp://user:DO_NOT_DISPLAY@ip'}),{status:502});
        return new Response(JSON.stringify({type:'answer',sdp:'test-answer'}));
      };
    });
    await page.goto(origin);
    await page.selectOption('#cameraSourceSelect','tapo');
    assert.equal(await page.inputValue('#recameraRtspPath'),'/stream1');
    assert.equal(await page.inputValue('#recameraUser'),'');
    await page.fill('#recameraIp','192.168.1.100');
    await page.fill('#recameraUser','camera-user');
    await page.fill('#recameraPassword','only-in-memory');
    await page.click('#startCamera');
    await page.waitForFunction(()=>document.querySelector('#viewerBadge').textContent==='Tapo C113 LIVE',null,{timeout:20000});
    assert.match(await page.textContent('#cameraStatus'),/640×480/);
    assert.match(await page.textContent('#micStatus'),/未连接/);
    await page.click('#captureBtn');
    assert.match(await page.getAttribute('#capturePreview','src'),/^data:image\/jpeg;base64,/);
    assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('only-in-memory')),false);
    assert.equal(await page.evaluate(()=>requests[0].rtsp_path),'/stream1');
    await page.click('#disconnectCamera');
    assert.equal(await page.evaluate(()=>document.querySelector('#video').srcObject),null);
    await page.selectOption('#cameraSourceSelect','recamera');
    assert.equal(await page.inputValue('#recameraRtspPath'),'/main');
    assert.equal(await page.inputValue('#recameraUser'),'admin');
    assert.equal(await page.inputValue('#recameraPassword'),'');
    await page.selectOption('#cameraSourceSelect','imx415');
    assert.equal(await page.isEnabled('#cameraSelect'),true);
    assert.equal(await page.locator('.camera-adapter-panel').first().evaluate(e=>e.classList.contains('show')),false);
    await page.selectOption('#cameraSourceSelect','tapo');
    assert.equal(await page.inputValue('#recameraIp'),'192.168.1.100');
    await page.fill('#recameraPassword','only-in-memory');
    await page.evaluate(()=>fakeMode='wait');
    await page.click('#startCamera');
    await page.waitForFunction(()=>requests.length===2);
    await page.click('#disconnectCamera');
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>LabSightCameraAdapters.peerConnection),null);
    assert.equal(dialogs.length,0);
    await page.evaluate(()=>fakeMode='error');
    await page.click('#startCamera');
    await page.waitForFunction(()=>document.querySelector('#cameraStatus').textContent==='Tapo C113 连接失败');
    assert.equal(dialogs.length,1);assert.equal(dialogs[0].includes('DO_NOT_DISPLAY'),false);
    assert.deepEqual(errors,[]);
    await page.evaluate(()=>peers.forEach(pc=>pc.close()));
    console.log('PASS: Tapo video → actual captureFrame JPEG, mic denial, profile isolation, credential storage, cancel, error redaction, UVC/IMX415 controls.');
  } finally {await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
