export function mount(root){
root.innerHTML = `
<div class="hstack">
<span class="badge">Cosmic Clock</span>
<span class="subtle">Next Equinox/Solstice</span>
</div>
<div class="clockline" id="cc-line">—</div>
<div class="tiny muted" id="cc-sub">syncing cycles...</div>
`;


const line = root.querySelector('#cc-line');
const sub = root.querySelector('#cc-sub');


function nextSeasonalBoundary(now=new Date()){
// Precomputed UTC boundaries (equinoxes/solstices) for 2025–2028.
// Source-independent placeholders, refine later if needed.
const boundaries = [
// 2025 — times roughly near published astronomical events
'2025-03-20T04:01:00Z', // March equinox
'2025-06-21T08:42:00Z', // June solstice
'2025-09-22T18:20:00Z', // September equinox (approx)
'2025-12-21T21:03:00Z', // December solstice
// 2026
'2026-03-20T10:46:00Z', '2026-06-21T14:25:00Z', '2026-09-23T00:06:00Z', '2026-12-21T03:12:00Z',
// 2027
'2027-03-20T16:25:00Z', '2027-06-21T20:11:00Z', '2027-09-23T05:02:00Z', '2027-12-21T09:22:00Z',
// 2028
'2028-03-20T22:17:00Z', '2028-06-21T02:02:00Z', '2028-09-22T10:45:00Z', '2028-12-21T15:19:00Z'
].map(s => new Date(s));
return boundaries.find(d => d > now) || boundaries[boundaries.length-1];
}


function fmt(ms){
const s = Math.max(0, Math.floor(ms/1000));
const d = Math.floor(s/86400);
const h = Math.floor((s%86400)/3600);
const m = Math.floor((s%3600)/60);
const sec = s%60;
return `${d}d ${h}h ${m}m ${sec}s`;
}


function tick(){
const now = new Date();
const next = nextSeasonalBoundary(now);
const diff = next - now;
line.textContent = fmt(diff);
sub.textContent = `→ ${next.toUTCString()} — global holiday clock`;
if (diff <= 0) clearInterval(timer);
}


tick();
const timer = setInterval(tick, 1000);
}