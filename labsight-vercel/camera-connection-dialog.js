(() => {
  // Network camera credentials stay in this page and are never persisted here.
  window.LabSightCameraDialog = ({panel, id, button, profile, connect, disconnect, checkBridge, connected}) => {
    const dialog = document.createElement('dialog');
    dialog.id = id('cameraConnectionDialog');
    dialog.className = 'camera-connection-dialog';
    dialog.setAttribute('aria-labelledby', id('cameraDialogTitle'));
    dialog.innerHTML = `<form class="camera-connection-form">
      <header><h3 id="${id('cameraDialogTitle')}"></h3><button type="button" class="secondary camera-dialog-close" aria-label="关闭摄像头配置">✕</button></header>
      <p class="camera-dialog-note">填写摄像机账户后连接。IP、用户名和码流会记住；密码仅在本次页面中保留。</p>
      <div class="camera-dialog-fields"></div><p class="camera-dialog-progress" role="status" aria-live="polite"></p>
      <footer><button type="button" class="secondary camera-dialog-cancel">取消</button><button type="submit" class="primary camera-dialog-connect">连接</button></footer>
    </form>`;
    dialog.querySelector('.camera-dialog-fields').appendChild(panel);
    panel.classList.add('show');
    document.body.appendChild(dialog);
    const form=dialog.querySelector('form'), submit=dialog.querySelector('[type=submit]'), progress=dialog.querySelector('[role=status]');
    let busy=false, values=[], attempt=0;
    function cancel() {
      attempt++;
      if (busy) disconnect();
      busy=false;submit.disabled=false;
      values.forEach(([input,value])=>{input.value=value;});
      dialog.close();
    }
    dialog.addEventListener('cancel', event=>{event.preventDefault();cancel();});
    dialog.querySelector('.camera-dialog-close').addEventListener('click',cancel);
    dialog.querySelector('.camera-dialog-cancel').addEventListener('click',cancel);
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy)return;
      const current=++attempt;busy=true;submit.disabled=true;progress.textContent='正在连接摄像头…';
      try {
        await connect();
        if(current!==attempt)return;
        if(connected()){dialog.close();progress.textContent='';}
        else progress.textContent='连接未完成，请检查配置后重试。';
      } finally {if(current===attempt){busy=false;submit.disabled=false;}}
    });
    return {open(){
      if(dialog.open)return;
      values=[...panel.querySelectorAll('input')].map(input=>[input,input.value]);
      dialog.querySelector('h3').textContent=`${button.closest('.camera-slot')?.querySelector('strong')?.textContent || '摄像头'} · ${profile().name}`;
      progress.textContent='';submit.textContent=connected()?'重新连接':'连接';
      dialog.showModal();
      const input=[...panel.querySelectorAll('input')].find(input=>!input.value) || panel.querySelector('input');
      input?.focus();
      void checkBridge();
    }};
  };
})();
