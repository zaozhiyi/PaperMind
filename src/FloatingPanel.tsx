import { useEffect, useRef, type ReactNode } from 'react';
type Point={x:number;y:number};
export function FloatingPanel({children,expanded,point,onPoint}:{children:ReactNode;expanded:boolean;point:Point|null;onPoint:(p:Point)=>void}) {
  const panel=useRef<HTMLElement>(null),drag=useRef<{x:number;y:number;left:number;top:number}|null>(null);
  const clamp=(x:number,y:number)=>{const r=panel.current!.getBoundingClientRect();return{x:Math.max(8,Math.min(x,window.innerWidth-r.width-8)),y:Math.max(62,Math.min(y,window.innerHeight-r.height-8))};};
  useEffect(()=>{const resize=()=>{if(panel.current&&!expanded){const r=panel.current.getBoundingClientRect();onPoint(clamp(r.left,r.top));}};resize();window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[expanded,onPoint]);
  return <section ref={panel} className={`ai-float ${expanded?'expanded':''}`} role="dialog" aria-label="AI 对话浮层" style={!expanded&&point?{left:point.x,top:point.y,right:'auto',bottom:'auto'}:undefined}
    onPointerDown={e=>{const el=e.target as Element;if(expanded||e.button!==0||!el.closest('.float-header')||el.closest('button'))return;const r=e.currentTarget.getBoundingClientRect();drag.current={x:e.clientX,y:e.clientY,left:r.left,top:r.top};e.currentTarget.setPointerCapture(e.pointerId);e.preventDefault();}}
    onPointerMove={e=>{if(!drag.current)return;onPoint(clamp(drag.current.left+e.clientX-drag.current.x,drag.current.top+e.clientY-drag.current.y));}}
    onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
    onPointerCancel={()=>{drag.current=null;}}
    onKeyDown={e=>{if(expanded||!(e.target as Element).matches('.float-header strong')||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const r=e.currentTarget.getBoundingClientRect();onPoint(clamp(r.left+(e.key==='ArrowRight'?20:e.key==='ArrowLeft'?-20:0),r.top+(e.key==='ArrowDown'?20:e.key==='ArrowUp'?-20:0)));}}>{children}</section>;
}
