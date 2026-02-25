export const SITE_THEME_MARKER = "remember-site-theme-v1";

export function buildSiteThemeCss() {
  return `
:root{
  color-scheme: light dark;
  --theme-marker:${SITE_THEME_MARKER};
  --theme-bg:#f3f0ea;
  --theme-bg-soft:#f8f5ef;
  --theme-paper:#fbf9f5;
  --theme-surface:#ffffff;
  --theme-card:#f5f1ea;
  --theme-text:#22201d;
  --theme-muted:#6e655d;
  --theme-subtle:#8a817a;
  --theme-line:#ddd5cb;
  --theme-line-strong:#cbc1b6;
  --theme-accent:#6f818d;
  --theme-accent-soft:#dce3e7;
  --theme-focus:#8a9a80;
  --theme-danger:#8a4343;
  --theme-shadow:0 8px 24px rgba(41,32,24,0.05);
  --theme-radius:14px;
  --theme-motion:240ms;
}
@media (prefers-color-scheme: dark){
  :root{
    --theme-bg:#10151b;
    --theme-bg-soft:#151b22;
    --theme-paper:#171f27;
    --theme-surface:#1c242d;
    --theme-card:#1a2129;
    --theme-text:#e7e0d7;
    --theme-muted:#b7ada2;
    --theme-subtle:#928a80;
    --theme-line:#333a44;
    --theme-line-strong:#45505b;
    --theme-accent:#91a1aa;
    --theme-accent-soft:#29333c;
    --theme-focus:#9ead92;
    --theme-danger:#d29292;
    --theme-shadow:0 10px 28px rgba(0,0,0,0.25);
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  min-height:100vh;
  color:var(--theme-text);
  font-family:"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif;
  font-size:16px;
  line-height:1.72;
  background:
    radial-gradient(circle at 8% 2%,var(--theme-accent-soft) 0%,transparent 32%),
    linear-gradient(180deg,var(--theme-bg-soft) 0%,var(--theme-bg) 42%,var(--theme-paper) 100%);
}
body::before{
  content:"";
  position:fixed;
  inset:0;
  pointer-events:none;
  opacity:0.06;
  background:
    repeating-linear-gradient(0deg,rgba(0,0,0,0.06),rgba(0,0,0,0.06) 1px,transparent 1px,transparent 3px),
    repeating-linear-gradient(90deg,rgba(0,0,0,0.03),rgba(0,0,0,0.03) 1px,transparent 1px,transparent 4px);
}
main{position:relative;z-index:1}
a{color:inherit}
p{margin:0}
ul{margin:8px 0 0;padding-left:20px}
code{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--theme-card);
  border:1px solid var(--theme-line);
  border-radius:999px;
  padding:1px 8px;
}
.site-shell{
  max-width:1024px;
  margin:0 auto;
  padding:32px 20px 56px;
}
.hero,.panel{
  border:1px solid var(--theme-line);
  border-radius:var(--theme-radius);
  background:var(--theme-surface);
  box-shadow:var(--theme-shadow);
  animation:fadeSlide var(--theme-motion) ease both;
}
.hero{
  padding:28px 30px;
}
.hero h1{
  margin:0;
  font-family:"Noto Serif SC","Songti SC","SimSun",serif;
  font-weight:600;
  font-size:clamp(30px,4.8vw,42px);
  letter-spacing:0.02em;
}
.lead{
  margin-top:10px;
  color:var(--theme-muted);
}
.meta-row{
  margin-top:16px;
  padding-top:12px;
  border-top:1px solid var(--theme-line);
  display:flex;
  flex-wrap:wrap;
  gap:10px 16px;
}
.meta-chip{
  font-size:13px;
  color:var(--theme-subtle);
}
.panel{
  margin-top:18px;
  padding:18px 20px;
}
.panel h2,.panel h3{
  margin:0;
  font-family:"Noto Serif SC","Songti SC","SimSun",serif;
  font-weight:600;
}
.panel h2{font-size:25px}
.panel h3{
  margin-top:14px;
  font-size:20px;
}
.hint{
  margin-top:8px;
  color:var(--theme-subtle);
  font-size:13px;
}
.site-input{
  width:100%;
  border:1px solid var(--theme-line-strong);
  border-radius:10px;
  background:var(--theme-paper);
  color:var(--theme-text);
  padding:11px 12px;
  font:inherit;
  transition:border-color var(--theme-motion) ease,box-shadow var(--theme-motion) ease;
}
.site-input:focus-visible{
  outline:none;
  border-color:var(--theme-focus);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--theme-focus) 24%,transparent);
}
@supports not (color: color-mix(in srgb, black 50%, white)){
  .site-input:focus-visible{
    box-shadow:0 0 0 3px rgba(138,154,128,0.25);
  }
}
.site-button{
  border:1px solid var(--theme-line-strong);
  border-radius:10px;
  background:var(--theme-card);
  color:var(--theme-text);
  padding:11px 14px;
  font:inherit;
  cursor:pointer;
  transition:transform var(--theme-motion) ease,background-color var(--theme-motion) ease,border-color var(--theme-motion) ease,color var(--theme-motion) ease;
}
.site-button:hover{
  background:var(--theme-accent-soft);
  border-color:var(--theme-accent);
  color:var(--theme-accent);
}
.site-button:focus-visible{
  outline:none;
  border-color:var(--theme-focus);
}
.site-button:disabled{
  opacity:0.6;
  cursor:not-allowed;
  transform:none;
}
.grid-two{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:16px;
}
.table{
  width:100%;
  border-collapse:collapse;
}
.table th,.table td{
  border-bottom:1px solid var(--theme-line);
  text-align:left;
  padding:8px 6px;
}
.table th{
  color:var(--theme-muted);
  font-weight:600;
}
.tag-list{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
  margin-top:10px;
}
.tag{
  display:inline-flex;
  align-items:center;
  border:1px solid var(--theme-line-strong);
  border-radius:999px;
  padding:3px 10px;
  font-size:12px;
  color:var(--theme-muted);
  background:var(--theme-card);
}
.quote{
  margin-top:12px;
  border-left:2px solid var(--theme-line-strong);
  padding-left:12px;
  color:var(--theme-muted);
}
.muted{color:var(--theme-muted)}
@media (max-width: 860px){
  .site-shell{padding:22px 14px 40px}
  .hero{padding:22px 18px}
  .panel{padding:16px 14px}
  .grid-two{grid-template-columns:1fr}
}
@keyframes fadeSlide{
  from{opacity:0;transform:translateY(6px)}
  to{opacity:1;transform:translateY(0)}
}
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{
    animation:none !important;
    transition:none !important;
  }
}
`;
}
