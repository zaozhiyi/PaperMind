import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
type Appearance = { mode: 'light' | 'dark' | 'system'; accent: string; lightBackground: string; darkBackground: string };
const defaults: Appearance = { mode: 'system', accent: '#56738c', lightBackground: '#ffffff', darkBackground: '#1b1d20' };
const presets = [
  {name:'雾蓝',accent:'#56738c',lightBackground:'#ffffff',darkBackground:'#1b1d20'},
  {name:'纸页',accent:'#927046',lightBackground:'#faf6ed',darkBackground:'#25221e'},
  {name:'松绿',accent:'#527c68',lightBackground:'#f5f8f4',darkBackground:'#1c2420'},
  {name:'鸢紫',accent:'#7b689a',lightBackground:'#f8f6fb',darkBackground:'#23202a'},
];
const brightness = (hex: string) => .299*parseInt(hex.slice(1,3),16)+.587*parseInt(hex.slice(3,5),16)+.114*parseInt(hex.slice(5,7),16);
const validColor = (value: unknown): value is string => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(() => { try { const saved = JSON.parse(localStorage.getItem('yejian-appearance') || '{}'); return { mode: ['light','dark','system'].includes(saved.mode) ? saved.mode : defaults.mode, accent: validColor(saved.accent) ? saved.accent : defaults.accent, lightBackground: validColor(saved.lightBackground) ? saved.lightBackground : defaults.lightBackground, darkBackground: validColor(saved.darkBackground) ? saved.darkBackground : defaults.darkBackground }; } catch { return defaults; } });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => { const media = window.matchMedia('(prefers-color-scheme: dark)'); const change = () => setSystemDark(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
  const dark = appearance.mode === 'dark' || (appearance.mode === 'system' && systemDark);
  useEffect(() => { localStorage.setItem('yejian-appearance', JSON.stringify(appearance)); const root = document.documentElement; root.dataset.theme = dark ? 'dark' : 'light'; root.style.setProperty('--accent', appearance.accent); root.style.setProperty('--page', dark ? appearance.darkBackground : appearance.lightBackground); const pageDark=brightness(dark ? appearance.darkBackground : appearance.lightBackground)<140; root.style.setProperty('--page-ink',pageDark?'#e7e8ea':'#2a2d32');root.style.setProperty('--page-muted',pageDark?'#a0a4ab':'#878c94');root.style.setProperty('--page-line',pageDark?'#ffffff18':'#00000012');root.style.setProperty('--page-soft',pageDark?'#ffffff08':'#00000004');root.style.setProperty('--accent-ink',brightness(appearance.accent)<150?'#ffffff':'#1b1d20');root.style.colorScheme = dark ? 'dark' : 'light'; }, [appearance, dark]);
  return { appearance, setAppearance, dark };
}
export function ThemeSettings({ appearance, setAppearance, dark }: ReturnType<typeof useAppearance>) {
  return <section className="appearance-settings"><h3>外观</h3><div className="theme-modes" role="group" aria-label="主题模式">{([{mode:'light',label:'浅色',icon:Sun},{mode:'dark',label:'深色',icon:Moon},{mode:'system',label:'跟随系统',icon:Monitor}] as const).map(({mode,label,icon:Icon}) => <button key={mode} aria-pressed={appearance.mode===mode} className={appearance.mode===mode ? 'selected' : ''} onClick={()=>setAppearance(a=>({...a,mode}))}><Icon size={16}/>{label}</button>)}</div><div className="theme-presets" role="group" aria-label="预设配色">{presets.map(p=><button key={p.name} aria-pressed={appearance.accent===p.accent&&appearance.lightBackground===p.lightBackground&&appearance.darkBackground===p.darkBackground} onClick={()=>setAppearance(a=>({...a,...p}))}><span style={{background:dark?p.darkBackground:p.lightBackground,borderColor:p.accent}}><i style={{background:p.accent}}/></span>{p.name}</button>)}</div><details className="custom-colors"><summary>自定义颜色</summary><div className="color-settings"><label>强调色<input type="color" aria-label="强调色" value={appearance.accent} onChange={e=>setAppearance(a=>({...a,accent:e.target.value}))}/></label><label>{dark ? '深色页面背景' : '浅色页面背景'}<input type="color" aria-label="页面背景色" value={dark ? appearance.darkBackground : appearance.lightBackground} onChange={e=>setAppearance(a=>({...a,[dark ? 'darkBackground' : 'lightBackground']:e.target.value}))}/></label><button className="text-button" onClick={()=>setAppearance(defaults)}>恢复默认</button></div></details></section>;
}
