// Ephemeral choices and thumbnails from already received frames only. No URLs,
// storage, native identifiers, additional capture or background preview polling.
export function createWindowChooser({document,trigger,list,status,canSelect,send,snapshot}) {
 let enabled=false,state=null;
 const previews=new Map(),buttons=new Map();
 const validKey=k=>typeof k==='string'&&/^[A-Za-z0-9_-]{16}$/.test(k);
 const discard=()=>{for(const p of previews.values()){p.width=0;p.height=0;}previews.clear();};
 function refresh(){
  trigger.hidden=!enabled||!state;
  trigger.disabled=!enabled||!state||!canSelect()||state.switching;
  for(const [key,button] of buttons){
   button.disabled=!enabled||!canSelect()||state.switching;
   button.setAttribute('aria-pressed',String(key===state.current));
  }
 }
 function render(){
  const focused=document.activeElement?.dataset?.windowKey;
  list.replaceChildren();buttons.clear();
  for(const target of state.windows){
   const button=document.createElement('button');button.type='button';button.dataset.windowKey=target.key;
   const label=document.createElement('span');label.textContent=target.label;button.append(label);
   const preview=previews.get(target.key);
   if(preview){preview.setAttribute('aria-hidden','true');button.append(preview);}
   const hint=document.createElement('small');hint.textContent=preview?'Last viewed':target.key===state.current?'Viewing now':'Preview after viewing';button.append(hint);
   button.addEventListener('click',()=>{
    if(!enabled||!state||!canSelect()||state.switching||target.key===state.current)return;
    // Snapshot before retiring the current media epoch; never capture the new
    // target until its own authorized video has actually arrived.
    const previous=snapshot();
    if(previous){const old=previews.get(state.current);if(old){old.width=0;old.height=0;}previews.set(state.current,previous);}
    if(send({type:'window-select',key:target.key})) {state={...state,switching:true};status.textContent='Switching window…';render();}
   });
   list.append(button);buttons.set(target.key,button);
  }
  refresh();
  if(focused&&buttons.has(focused))buttons.get(focused).focus({preventScroll:true});
 }
 return {
  supported(value){enabled=value===true;refresh();},
  receive(message){
   if(!enabled||!message||message.type!=='window-state'||!validKey(message.grant)||!validKey(message.current)
     ||typeof message.switching!=='boolean'||!Array.isArray(message.windows)||message.windows.length<2||message.windows.length>8
     ||message.windows.some(t=>!t||Object.keys(t).length!==2||!validKey(t.key)||typeof t.label!=='string'||!t.label.trim()||t.label.length>80
       ||/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(t.label))
     ||new Set(message.windows.map(t=>t.key)).size!==message.windows.length
     ||!message.windows.some(t=>t.key===message.current)||![undefined,'busy','wait'].includes(message.error))throw Error('Unexpected window selection response.');
   if(state&&state.grant===message.grant && JSON.stringify(state.windows)!==JSON.stringify(message.windows))throw Error('Window selection changed unexpectedly.');
   if(!state||state.grant!==message.grant)discard();
   state=message;
   status.textContent=message.error==='busy'?'Window switching is busy. Try again shortly.':message.error==='wait'?'Wait two seconds between window switches, then try again.'
     :message.switching?'Switching window…':'View only · audio off. Select a window to view it.';
   render();
  },
  refresh,
  clear(){enabled=false;state=null;discard();buttons.clear();list.replaceChildren();status.textContent='';refresh();},
 };
}
