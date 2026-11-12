const root = document.getElementById('results');
let record = null;
function segments(pass) {
  return Array.isArray(pass.screenshots) && pass.screenshots.length
    ? pass.screenshots : (pass.screenshot ? [{y: pass.state?.scrollY || 0, screenshot: pass.screenshot}] : []);
}
async function load() {
  const result = await browser.storage.local.get('ursLastPassCapture');
  record = result.ursLastPassCapture || null;
  root.replaceChildren();
  if (!record) { root.textContent = 'No captures yet. Enable the test checkbox and run Dynamic.'; return; }
  const summary = document.createElement('pre');
  summary.textContent = JSON.stringify({url: record.url, mode: record.mode,
    status: record.status, startedAt: new Date(record.startedAt).toISOString(),
    passes: (record.passes || []).length}, null, 2);
  root.append(summary);
  for (const pass of (record.passes || [])) {
    const block = document.createElement('section'); block.className = 'pass';
    const title = document.createElement('h2');
    title.textContent = `Pass ${pass.pass}/${pass.expected} — ${pass.note || (pass.covered ? 'Completed' : 'Incomplete')}`;
    block.append(title);
    const metadata = document.createElement('pre');
    metadata.textContent = JSON.stringify({at:pass.at, ...(pass.state || {}),
      sampled:pass.sampled, totalPositions:pass.totalPositions,
      captureError:pass.captureError, exportError:pass.exportError}, null, 2);
    block.append(metadata);
    if (pass.captureError || pass.exportError) metadata.classList.add('error');
    const shots = segments(pass);
    if (!shots.length) {const p=document.createElement('p');p.textContent='No screenshots available for this pass.';block.append(p);}
    shots.forEach((shot, i) => {
      const wrap=document.createElement('div'); wrap.className='segment';
      const label=document.createElement('p');label.className='meta';
      label.textContent=`Segment ${i+1}/${shots.length} — scroll position ${shot.y || 0}px`;
      const a=document.createElement('a');a.href=shot.screenshot;
      a.download=`URS-pass-${pass.pass}-segment-${i+1}.jpg`;
      a.textContent='Save this image';
      const img=document.createElement('img');img.src=shot.screenshot;
      img.alt=label.textContent;img.loading='lazy';
      wrap.append(label,a,img);block.append(wrap);
    });
    root.append(block);
  }
}
function downloadBlob(blob, filename) {
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
document.getElementById('refresh').addEventListener('click',()=>load().catch(e=>root.textContent=String(e)));
document.getElementById('export').addEventListener('click',()=>{
  if (!record) return;
  const clean={...record,passes:(record.passes || []).map(p=>({...p,screenshot:null,
    screenshots:segments(p).map(({y})=>({y}))}))};
  downloadBlob(new Blob([JSON.stringify(clean,null,2)],{type:'application/json'}),'URS-pass-diagnostics.json');
});
document.getElementById('html-export').addEventListener('click',()=>{
  if (!record) return;
  // Self-contained scrollable report; no need for a folder or broken downloads API.
  const content=document.documentElement.cloneNode(true);
  content.querySelectorAll('script').forEach(node=>node.remove());
  const controls=content.querySelector('#html-export')?.parentElement;
  if (controls) controls.remove();
  const results=content.querySelector('#results');
  if (results) results.replaceWith(root.cloneNode(true));
  const html='<!doctype html>\n'+content.outerHTML;
  downloadBlob(new Blob([html],{type:'text/html;charset=utf-8'}), 'URS-Dynamic-Visual-Report.html');
});
load().catch(e=>root.textContent=String(e));