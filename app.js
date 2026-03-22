const MATERIAL_COLORS = {
  CN10: { bg: '#facc15', border: '#fcd34d', text: '#78350f' },
  CN20: { bg: '#374151', border: '#1f2937', text: '#fff' },
  RS40: { bg: '#7dd3e8', border: '#5bb8cc', text: '#1a3a4a' },
  RS20: { bg: '#9ca3af', border: '#6b7280', text: '#fff' },
  CM20: { bg: '#d1d5db', border: '#b0b5bc', text: '#374151' }
};

const SPACE_TYPE_COLORS = {
  '반박스': '#6366f1',
  '풀박스': '#9333ea',
  '흰색': '#64748b',
  '노란색': '#d97706',
  '초소형': '#0891b2',
  '서랍': '#db2777'
};

let TSV_DATA = '';

async function loadLayoutData() {
  try {
    const response = await fetch('layout.tsv');
    const text = await response.text();
    TSV_DATA = '섹션\t층\t단\t거리순서\t챕터\t저장상태\t상태\t공간유형\n' + text;
  } catch (e) {
    console.error('Failed to load layout.tsv:', e);
    TSV_DATA = '';
  }
}

function parseTSV(tsv){
  const lines = tsv.trim().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(lines.length<=1) return [];
  const rows = [];
  for(let i=1;i<lines.length;i++){
    const line = lines[i];
    let cells = line.includes('\t') ? line.split('\t') : line.split(/\s+/);
    while(cells.length < 8) cells.push('');
    const [section,floor,_dan,order,_chapter,saved,status,type] = cells.map(x=>(x??'').trim());
    rows.push({
      section: section || '',
      floor: floor ? Number(floor) : null,
      order: order ? Number(order) : null,
      saved: saved ? Number(saved) : 0,
      status: status || '',
      type: type || ''
    });
  }
  return rows.filter(r=>r.section && r.floor && r.order);
}

function keyOf(r){
  return `${r.section}|${Number(r.floor)}|${Number(r.order)}`;
}

let baseRows = [];
let data = [];

async function initData() {
  await loadLayoutData();
  baseRows = parseTSV(TSV_DATA);
  data = baseRows.map((r, idx) => ({
    id: idx,
    key: keyOf(r),
    section: r.section,
    floor: r.floor,
    order: r.order,
    saved: r.saved ?? 0,
    status: r.status === 'HOLD' ? 'UNUSED' : r.status === 'ACTIVE' ? '' : r.status ?? '',
    type: r.type ?? '',
    item: '',
    material: '',
    qty: '',
    inDate: '',
    memo: ''
  }));
}

let shipmentData = {};

function getStaleInfo(d){
  if(!d || !d.item) return {stale:false, top100:false};
  const baseMat = (d.material||'').split(/[(\s]/)[0];
  const key = baseMat + '|' + d.item.toLowerCase();
  const info = shipmentData[key];
  const today = new Date();
  today.setHours(0,0,0,0);
  const top100 = info && info.top100 ? info.top100 : false;
  if(!info){
    return {stale:true, days:-1, lastOut:'', lastIn:'', top100};
  }
  const lastIn = info.lastIn||'';
  const lastOut = info.lastOut||'';
  const lastAny = [lastOut, lastIn].filter(Boolean).sort().pop() || '';
  let daysSinceLast = -1;
  if(lastAny){
    const lastDate = new Date(lastAny);
    daysSinceLast = Math.floor((today - lastDate)/(1000*60*60*24));
  }
  const stale = !lastAny || daysSinceLast >= 1000;
  return {stale, days: daysSinceLast, lastOut, lastIn, top100};
}

let qtyTop100 = new Set();
function buildQtyTop100(){
  const qtyMap = {};
  data.forEach(d=>{
    if(!d.item || !d.qty) return;
    const baseMat = (d.material||'').split(/[(\s]/)[0];
    const key = baseMat + '|' + d.item.toLowerCase();
    const q = parseInt(d.qty)||0;
    if(q > (qtyMap[key]||0)) qtyMap[key] = q;
  });
  const sorted = Object.entries(qtyMap).sort((a,b)=>b[1]-a[1]);
  qtyTop100 = new Map(sorted.slice(0,100).map(([k,v],i)=>[k,i+1]));
}

let shipmentHistory = null;

async function loadShipmentData(){
  try{
    const cached = localStorage.getItem('shipmentDataCache');
    const cacheTime = localStorage.getItem('shipmentDataTime');
    if(cached && cacheTime && Date.now() - Number(cacheTime) < 3600000){
      shipmentData = JSON.parse(cached);
      buildQtyTop100();
      renderAll();
    }
  }catch(e){}
}

// Apps Script 웹 앱 URL (배포 후 입력)
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzr32X5GMnga-kbDkxqlevKkte_wnG7ADhjY-PAqH4TB8D6akN9P0L4SWPeBzX1Ua76eQ/exec';

async function loadFromSheet(){
  try{
    let rows = null;

    // 1순위: Apps Script API (CORS 문제 없음, 양방향 동기화)
    if(APPS_SCRIPT_URL){
      const res = await fetch(APPS_SCRIPT_URL);
      const json = await res.json();
      if(json.success) rows = json.data;
    }

    // 2순위: CSV export (로컬에서만 동작, github.io에서는 CORS 차단)
    if(!rows){
      const sheetId = '1zWCMLdOZGgYUTN8Bj3kDfW5XpXN7CqZZm6DXrX2yZgE';
      const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;
      const res = await fetch(url);
      const csv = await res.text();
      const lines = csv.trim().split('\n');
      const header = lines[0].split(',').map(h => h.trim().toLowerCase());
      rows = [];
      for(let i=1; i<lines.length; i++){
        const values = lines[i].split(',').map(v => v.trim());
        const obj = {};
        header.forEach((h,j) => obj[h] = values[j]||'');
        rows.push(obj);
      }
    }

    if(!rows) return;

    rows.forEach(obj => {
      const loc = obj.location||'';
      const m = loc.match(/([A-P])(\d+)-(\d+)/);
      if(!m) return;
      const [,section,floor,order] = m;
      const idx = data.findIndex(d => d.section===section && d.floor===Number(floor) && d.order===Number(order));
      if(idx<0) return;
      data[idx].item = obj.dimension||obj.item||'';
      data[idx].material = obj.material||'';
      data[idx].qty = obj.quantity||obj.qty||'';
      data[idx].inDate = obj['in date']||obj.indate||'';
      data[idx].memo = obj.memo||obj.note||obj.comments||'';
    });

    localStorage.setItem('warehouseDataCache', JSON.stringify(data));
    localStorage.setItem('warehouseDataTime', Date.now().toString());
  }catch(e){
    console.error('Sheet load error:', e);
  }
}

async function syncToSheet(slotData){
  if(!APPS_SCRIPT_URL) return;
  const location = `${slotData.section}${slotData.floor}-${slotData.order}`;
  try{
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        location, item: slotData.item||'', material: slotData.material||'',
        qty: slotData.qty||'', inDate: slotData.inDate||'', memo: slotData.memo||''
      })
    });
  }catch(e){ console.error('Sheet sync error:', e); }
}

function loadFromCache(){
  try{
    const cached = localStorage.getItem('warehouseDataCache');
    const cacheTime = localStorage.getItem('warehouseDataTime');
    if(cached && cacheTime && Date.now() - Number(cacheTime) < 3600000){
      const cachedData = JSON.parse(cached);
      cachedData.forEach((cd,idx) => {
        if(data[idx]){
          data[idx].item = cd.item||'';
          data[idx].material = cd.material||'';
          data[idx].qty = cd.qty||'';
          data[idx].inDate = cd.inDate||'';
          data[idx].memo = cd.memo||'';
        }
      });
    }
  }catch(e){
    console.error('Cache load error:', e);
  }
}

let currentTab = 'full', prevTab = '';
let currentSection = null;
const historyStack = [];

function switchTab(tab){
  if(tab === currentTab) return;
  prevTab = currentTab;
  currentTab = tab;
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
  document.querySelectorAll('.tabbar-item').forEach(t => t.classList.remove('on'));
  const panelId = `panel-${tab}`;
  const tabId = `tab-${tab}`;
  const panel = document.getElementById(panelId);
  const tabItem = document.getElementById(tabId);
  if(panel) panel.classList.add('on');
  if(tabItem) tabItem.classList.add('on');
  if(tab === 'full') renderFullView();
}

function goBackTab(){
  if(prevTab) switchTab(prevTab);
}

function updatePrintQueue(){
  const badges = document.querySelectorAll('#pqBadge');
  const count = printQueue.length;
  badges.forEach(b => {
    if(count > 0){
      b.textContent = count;
      b.style.display = 'inline-block';
    } else {
      b.style.display = 'none';
    }
  });
  const btn = document.getElementById('pdfBtn');
  if(btn) btn.disabled = count === 0;
}

function showToast(msg){
  const toast = document.getElementById('toast');
  if(toast){
    toast.textContent = msg;
    toast.style.display = 'block';
    setTimeout(() => toast.style.display = 'none', 2500);
  }
}

let printQueue = [];

function addToQueue(){
  const loc = document.getElementById('sheetLoc').textContent;
  const item = document.getElementById('sheetItem').value;
  const mat = document.getElementById('sheetMaterial').value;
  if(!loc || loc==='-' || !item) { showToast('치수를 입력해주세요'); return; }
  printQueue.push({ loc, item, material: mat || '' });
  updatePrintQueue();
  showToast('인쇄 대기열에 추가됨');
  closeSheet();
}

function renderPrintQueue(){
  const list = document.getElementById('pqList');
  if(!list) return;
  if(printQueue.length === 0){
    list.innerHTML = '<div class="pq-empty">인쇄 대기열이 비어있습니다</div>';
    return;
  }
  list.innerHTML = printQueue.map((item, idx) => `
    <div class="pq-card">
      <div class="pq-card-loc">${item.loc}</div>
      <div class="pq-card-item">${item.item}</div>
      ${item.material ? `<div class="pq-card-mat" style="background:${getMaterialColor(item.material)}">${item.material}</div>` : ''}
      <button class="pq-card-del" onclick="removePrintQueue(${idx})">✕</button>
    </div>
  `).join('');
  document.getElementById('pqCount').textContent = printQueue.length + '개';
}

function removePrintQueue(idx){
  printQueue.splice(idx, 1);
  updatePrintQueue();
  renderPrintQueue();
}

function clearPrintQueue(){
  if(confirm('인쇄 대기열을 전부 삭제하시겠습니까?')){
    printQueue = [];
    updatePrintQueue();
    renderPrintQueue();
  }
}

function getMaterialColor(mat){
  const baseMat = (mat||'').split(/[(\s]/)[0];
  const colors = MATERIAL_COLORS[baseMat];
  return colors ? colors.bg : '#e8e4de';
}

let currentEditCard = null;

function openSheet(slotId){
  const slot = data[slotId];
  if(!slot) return;
  const loc = `${slot.section}${slot.floor}-${slot.order}`;
  document.getElementById('sheetLoc').textContent = loc;
  document.getElementById('sheetType').value = slot.type || '';
  document.getElementById('sheetStatus').value = slot.status === 'UNUSED' ? 'UNUSED' : '';
  document.getElementById('sheetItem').value = slot.item || '';
  document.getElementById('sheetMaterial').value = slot.material || '';
  document.getElementById('sheetQty').value = slot.qty || '';
  document.getElementById('sheetInDate').value = slot.inDate || '';
  document.getElementById('sheetMemo').value = slot.memo || '';
  document.getElementById('sheetBackdrop').classList.add('on');
  document.getElementById('sheet').classList.add('on');
}

function closeSheet(){
  document.getElementById('sheetBackdrop').classList.remove('on');
  document.getElementById('sheet').classList.remove('on');
}

function saveSheet(){
  const loc = document.getElementById('sheetLoc').textContent;
  const m = loc.match(/([A-P])(\d+)-(\d+)/);
  if(!m) return;
  const [,section,floor,order] = m;
  const idx = data.findIndex(d => d.section===section && d.floor===Number(floor) && d.order===Number(order));
  if(idx < 0) return;
  data[idx].type = document.getElementById('sheetType').value || '';
  data[idx].status = document.getElementById('sheetStatus').value || '';
  data[idx].item = document.getElementById('sheetItem').value || '';
  data[idx].material = document.getElementById('sheetMaterial').value || '';
  data[idx].qty = document.getElementById('sheetQty').value || '';
  data[idx].inDate = document.getElementById('sheetInDate').value || '';
  data[idx].memo = document.getElementById('sheetMemo').value || '';
  localStorage.setItem('warehouseDataCache', JSON.stringify(data));
  localStorage.setItem('warehouseDataTime', Date.now().toString());
  syncToSheet(data[idx]);
  renderAll();
  closeSheet();
  showToast('저장됨');
}

let searchFilter = { empty: false, materials: new Set(), stale: false };

function onSearch(){
  const q = document.getElementById('searchInput').value.toLowerCase();
  const panel = document.getElementById('searchResultPanel');
  const list = document.getElementById('searchResultList');
  if(!q){
    panel.classList.remove('on');
    return;
  }
  document.getElementById('searchFilterBar').classList.add('on');
  const results = data.filter(d => {
    if(searchFilter.empty && d.item) return false;
    if(searchFilter.materials.size > 0 && !searchFilter.materials.has((d.material||'').split(/[(\s]/)[0])) return false;
    if(searchFilter.stale && !getStaleInfo(d).stale) return false;
    const loc = `${d.section}${d.floor}-${d.order}`.toLowerCase();
    const item = (d.item||'').toLowerCase();
    return loc.includes(q) || item.includes(q);
  });
  if(results.length === 0){
    list.innerHTML = '<div class="no-results"><div class="no-results-icon">🔍</div>검색 결과가 없습니다</div>';
  } else {
    list.innerHTML = results.map(d => `
      <div class="result-card" onclick="openSlotPopup(${d.id})">
        <div class="result-loc">
          <div class="result-path">${d.section}${d.floor}-${d.order}</div>
          <div class="result-item">${d.item || '(치수 없음)'}</div>
          <div class="result-meta">
            <span class="result-status ${d.status||'IN'}">${d.status==='UNUSED'?'🔴 미사용':d.item?'🟢 입고':'⬜ 공실'}</span>
          </div>
        </div>
      </div>
    `).join('');
  }
  document.getElementById('searchResultHeader').textContent = `검색 결과 (${results.length}개)`;
  panel.classList.add('on');
}

function clearSearch(){
  document.getElementById('searchInput').value = '';
  document.getElementById('searchResultPanel').classList.remove('on');
  document.getElementById('searchFilterBar').classList.remove('on');
}

function toggleEmptyFilter(el){
  searchFilter.empty = !searchFilter.empty;
  el.classList.toggle('on');
  onSearch();
}

function toggleMatFilter(mat, el){
  if(searchFilter.materials.has(mat)) searchFilter.materials.delete(mat);
  else searchFilter.materials.add(mat);
  el.classList.toggle('on');
  onSearch();
}

function toggleStaleFilter(el){
  searchFilter.stale = !searchFilter.stale;
  el.classList.toggle('on');
  onSearch();
}

let overviewFilter = 'all';

function setFilter(type, el){
  overviewFilter = type;
  document.querySelectorAll('.filter-row .fchip').forEach(c => c.classList.remove('on'));
  el.classList.add('on');
  renderOverviewGrid();
}

function renderOverviewGrid(){
  const grid = document.getElementById('overviewGrid');
  const sections = [...new Set(data.map(d => d.section))].sort();
  grid.innerHTML = sections.map(sec => {
    const aisles = [...new Set(data.filter(d => d.section===sec).map(d => d.floor))].sort((a,b) => a-b);
    return aisles.map(aisle => {
      const slots = data.filter(d => d.section===sec && d.floor===aisle);
      const stats = { IN: 0, EMPTY: 0, UNUSED: 0 };
      const floors = {};
      slots.forEach(s => {
        const st = s.status === 'UNUSED' ? 'UNUSED' : s.item ? 'IN' : 'EMPTY';
        stats[st]++;
        if(!floors[s.floor]) floors[s.floor] = { IN: 0, EMPTY: 0, UNUSED: 0 };
        floors[s.floor][st]++;
      });
      const filtered = overviewFilter === 'all' ? slots : slots.filter(s => {
        const st = s.status === 'UNUSED' ? 'UNUSED' : s.item ? 'IN' : 'EMPTY';
        return st === overviewFilter;
      });
      return `
        <div class="aisle-block">
          <div class="aisle-label">${sec}-${aisle}층</div>
          <div class="aisle-sections">
            <div class="ov-sec" onclick="openSection('${sec}')">
              <div class="ov-sec-name">${sec}</div>
              <div class="ov-chips">
                <span class="ov-chip in">🟢 ${stats.IN}</span>
                <span class="ov-chip empty">⬜ ${stats.EMPTY}</span>
                <span class="ov-chip unused">🔴 ${stats.UNUSED}</span>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }).join('');
  renderStatsRow();
}

function renderStatsRow(){
  const row = document.getElementById('statsRow');
  if(!row) return;
  const stats = { IN: 0, EMPTY: 0, UNUSED: 0 };
  data.forEach(d => {
    const st = d.status === 'UNUSED' ? 'UNUSED' : d.item ? 'IN' : 'EMPTY';
    stats[st]++;
  });
  row.innerHTML = `
    <div class="stat-chip"><div class="sdot" style="background:#059669"></div>입고: <b>${stats.IN}</b></div>
    <div class="stat-chip"><div class="sdot" style="background:#64748b"></div>공실: <b>${stats.EMPTY}</b></div>
    <div class="stat-chip"><div class="sdot" style="background:#94a3b8"></div>미사용: <b>${stats.UNUSED}</b></div>
  `;
}

let recommendMode = false;
const recommendedSlots = [];

function openRecommend(){
  if(recommendMode) { closeRecommend(); return; }
  recommendMode = true;
  const input = document.getElementById('sheetItem');
  const item = input?.value || '';
  if(!item) { showToast('편집창에서 치수를 먼저 입력해주세요'); return; }
  const empty = data.filter(d => !d.item && d.status !== 'UNUSED').sort((a,b) => {
    const aIdx = a.floor*1000 + a.order;
    const bIdx = b.floor*1000 + b.order;
    return aIdx - bIdx;
  }).slice(0, 10);
  recommendedSlots.length = 0;
  empty.forEach(s => recommendedSlots.push(s));
  renderRecommendPanel();
  document.getElementById('recommendPanel').classList.add('on');
}

function renderRecommendPanel(){
  const panel = document.getElementById('recommendPanel');
  const subtitle = document.getElementById('recommendSubtitle');
  const list = document.getElementById('recommendList');
  if(recommendedSlots.length === 0){
    subtitle.textContent = '추천할 빈 슬롯이 없습니다';
    list.innerHTML = '<div class="pq-empty">모든 슬롯이 사용 중입니다</div>';
    return;
  }
  subtitle.textContent = `${recommendedSlots.length}개의 빈 슬롯을 찾았습니다`;
  list.innerHTML = recommendedSlots.map((s, idx) => `
    <div class="rec-card" onclick="selectRecommendedSlot(${idx})">
      <div class="rec-rank">${idx + 1}</div>
      <div class="rec-info">
        <div class="rec-loc">${s.section}${s.floor}-${s.order}</div>
        <div class="rec-reason">타입: ${s.type || '미지정'}</div>
      </div>
    </div>
  `).join('');
}

function selectRecommendedSlot(idx){
  const slot = recommendedSlots[idx];
  closeRecommend();
  openSheet(slot.id);
}

function closeRecommend(){
  recommendMode = false;
  document.getElementById('recommendPanel').classList.remove('on');
  recommendedSlots.length = 0;
}

let slotPopupData = null;
let slotPopupItems = [];

function openSlotPopup(slotId){
  slotPopupData = data[slotId];
  if(!slotPopupData) return;
  const loc = `${slotPopupData.section}${slotPopupData.floor}-${slotPopupData.order}`;
  document.getElementById('popupTitle').textContent = loc;
  const st = slotPopupData.status === 'UNUSED' ? '미사용' : slotPopupData.item ? '입고' : '공실';
  document.getElementById('popupSubtitle').textContent = `(${st})`;
  slotPopupItems = [];
  if(slotPopupData.item) slotPopupItems.push({
    id: 0,
    item: slotPopupData.item,
    material: slotPopupData.material,
    qty: slotPopupData.qty,
    inDate: slotPopupData.inDate,
    memo: slotPopupData.memo
  });
  renderPopupCards();
  document.getElementById('popupBackdrop').classList.add('on');
  document.getElementById('slotPopup').classList.add('on');
}

function renderPopupCards(){
  const cards = document.getElementById('popupCards');
  if(slotPopupItems.length === 0){
    cards.innerHTML = '<div class="wh-placeholder" style="grid-column:1/-1">슬롯이 비어있습니다</div>';
  } else {
    cards.innerHTML = slotPopupItems.map((item, idx) => `
      <div class="popup-card ${currentEditCard === idx ? 'editing' : ''}" onclick="editPopupSlot()" style="cursor:pointer" title="클릭하여 편집">
        <button class="card-delete" onclick="event.stopPropagation();deletePopupCard(${idx})">✕</button>
        <div class="card-mat">${item.material || ''}</div>
        <div class="card-item">${item.item}</div>
        <div class="card-qty">수량: ${item.qty || '0'}</div>
        ${item.memo ? `<div class="card-shipment">메모: ${item.memo}</div>` : ''}
        <div style="font-size:10px;color:var(--muted);margin-top:6px">✏️ 탭하여 편집</div>
      </div>
    `).join('');
  }
}

function closeSlotPopup(){
  slotPopupData = null;
  slotPopupItems = [];
  currentEditCard = null;
  document.getElementById('popupBackdrop').classList.remove('on');
  document.getElementById('slotPopup').classList.remove('on');
}

function deletePopupCard(idx){
  if(confirm('이 항목을 삭제하시겠습니까?')){
    slotPopupItems.splice(idx, 1);
    if(slotPopupItems.length === 0 && slotPopupData){
      slotPopupData.item = '';
      slotPopupData.material = '';
      slotPopupData.qty = '';
      slotPopupData.memo = '';
    }
    renderPopupCards();
  }
}

function addNewCard(){
  if(!slotPopupData) return;
  closeSlotPopup();
  openSheet(slotPopupData.id);
}

function editPopupSlot(){
  if(!slotPopupData) return;
  closeSlotPopup();
  openSheet(slotPopupData.id);
}

function saveSlotPopup(){
  if(!slotPopupData) return;
  const idx = slotPopupData.id;
  if(slotPopupItems.length > 0){
    const item = slotPopupItems[0];
    data[idx].item = item.item || '';
    data[idx].material = item.material || '';
    data[idx].qty = item.qty || '';
    data[idx].inDate = item.inDate || '';
    data[idx].memo = item.memo || '';
  } else {
    data[idx].item = '';
    data[idx].material = '';
    data[idx].qty = '';
    data[idx].memo = '';
  }
  localStorage.setItem('warehouseDataCache', JSON.stringify(data));
  localStorage.setItem('warehouseDataTime', Date.now().toString());
  syncToSheet(data[idx]);
  renderAll();
  closeSlotPopup();
  showToast('저장됨');
}

let sortColumn = 'loc', sortAsc = true;

function tblSort(col){
  const th = document.querySelector(`.wh-table th[onclick*="${col}"]`);
  document.querySelectorAll('.wh-table th').forEach(t => t.classList.remove('sorted'));
  if(sortColumn === col) {
    sortAsc = !sortAsc;
  } else {
    sortColumn = col;
    sortAsc = true;
  }
  if(th) th.classList.add('sorted');
  renderTableView();
}

function tblToggleAll(cb){
  document.querySelectorAll('.wh-table tbody input[type="checkbox"]').forEach(c => {
    c.checked = cb.checked;
    c.dispatchEvent(new Event('change'));
  });
  updateTableCheckUI();
}

function tblSelectAll(){
  document.querySelectorAll('.wh-table tbody input[type="checkbox"]').forEach(c => c.checked = true);
  document.querySelectorAll('.wh-table tbody tr').forEach(r => r.classList.add('selected'));
  updateTableCheckUI();
}

function tblClearSelect(){
  document.querySelectorAll('.wh-table tbody input[type="checkbox"]').forEach(c => c.checked = false);
  document.querySelectorAll('.wh-table tbody tr').forEach(r => r.classList.remove('selected'));
  updateTableCheckUI();
}

function updateTableCheckUI(){
  const cbs = document.querySelectorAll('.wh-table tbody input[type="checkbox"]:checked');
  const count = cbs.length;
  const countEl = document.getElementById('tblSelectedCount');
  if(countEl) {
    if(count > 0) {
      countEl.textContent = `${count}개 선택됨`;
      countEl.classList.add('on');
    } else {
      countEl.classList.remove('on');
    }
  }
  const allCb = document.getElementById('chkAll');
  if(allCb) allCb.checked = count > 0;
}

function printSelected(){
  const cbs = document.querySelectorAll('.wh-table tbody input[type="checkbox"]:checked');
  const selectedData = Array.from(cbs).map(cb => {
    const row = cb.closest('tr');
    const cells = row.querySelectorAll('td');
    return {
      loc: cells[1]?.textContent || '',
      item: cells[6]?.textContent || '',
      material: cells[7]?.textContent || ''
    };
  });
  if(selectedData.length === 0) { showToast('선택된 항목이 없습니다'); return; }
  const area = document.getElementById('printArea');
  area.innerHTML = selectedData.map(d => `
    <div class="print-card">
      <div class="print-card-color" style="width:20px;background:${getMaterialColor(d.material)}"></div>
      <div class="print-card-body">
        <div class="print-field">
          <div class="print-label">위치</div>
          <div class="print-loc">${d.loc}</div>
        </div>
        <div class="print-field">
          <div class="print-label">치수</div>
          <div class="print-value">${d.item}</div>
        </div>
      </div>
    </div>
  `).join('');
  area.style.display = 'block';
  setTimeout(() => {
    window.print();
    setTimeout(() => { area.style.display = 'none'; }, 500);
  }, 200);
}

function renderTableView(){
  const tbody = document.getElementById('whTableBody');
  let sorted = [...data];
  sorted.sort((a, b) => {
    let aVal, bVal;
    if(sortColumn === 'loc') {
      aVal = `${a.section}${a.floor}-${a.order}`;
      bVal = `${b.section}${b.floor}-${b.order}`;
    } else if(sortColumn === 'section') {
      aVal = a.section; bVal = b.section;
    } else if(sortColumn === 'floor') {
      aVal = a.floor; bVal = b.floor;
    } else if(sortColumn === 'type') {
      aVal = a.type; bVal = b.type;
    } else if(sortColumn === 'state') {
      aVal = a.status === 'UNUSED' ? 'UNUSED' : a.item ? 'IN' : 'EMPTY';
      bVal = b.status === 'UNUSED' ? 'UNUSED' : b.item ? 'IN' : 'EMPTY';
    } else if(sortColumn === 'item') {
      aVal = a.item; bVal = b.item;
    } else if(sortColumn === 'material') {
      aVal = a.material; bVal = b.material;
    } else if(sortColumn === 'qty') {
      aVal = parseInt(a.qty)||0; bVal = parseInt(b.qty)||0;
    } else if(sortColumn === 'inDate') {
      aVal = a.inDate; bVal = b.inDate;
    }
    if(aVal < bVal) return sortAsc ? -1 : 1;
    if(aVal > bVal) return sortAsc ? 1 : -1;
    return 0;
  });
  tbody.innerHTML = sorted.map((d, idx) => {
    const st = d.status === 'UNUSED' ? 'UNUSED' : d.item ? 'IN' : 'EMPTY';
    const loc = `${d.section}${d.floor}-${d.order}`;
    const matColor = getMaterialColor(d.material);
    return `
      <tr>
        <td><input type="checkbox" class="tbl-checkbox" onchange="updateTableCheckUI()"></td>
        <td onclick="openSlotPopup(${d.id})">${loc}</td>
        <td>${d.section}</td>
        <td>${d.floor}</td>
        <td>${d.type}</td>
        <td><span class="tbl-state ${st}">${st === 'UNUSED' ? '미사용' : st === 'IN' ? '입고' : '공실'}</span></td>
        <td>${d.item}</td>
        <td><span class="tbl-mat" style="background:${matColor}">${d.material}</span></td>
        <td>${d.qty}</td>
        <td>${d.inDate}</td>
        <td>${d.memo}</td>
      </tr>
    `;
  }).join('');
}

function openSection(sec){
  currentSection = sec;
  switchTab('full');
  renderDetailView();
}

function goBack(){
  currentSection = null;
  renderFullView();
}

function renderDetailView(){
  const warehouse = document.getElementById('fullWarehouse');
  if(!warehouse) return;
  const slots = data.filter(d => d.section === currentSection);
  const aisles = [...new Set(slots.map(d => d.floor))].sort((a,b) => a-b);
  warehouse.innerHTML = `
    <div style="padding:12px 16px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
        <button onclick="goBack()" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:7px 14px;cursor:pointer;font-size:13px;font-family:inherit">← 뒤로</button>
        <div style="font-family:'IBM Plex Mono';font-size:16px;font-weight:700;color:var(--accent)">${currentSection} 섹션</div>
      </div>
      ${aisles.map(aisle => {
        const aisleslots = slots.filter(d => d.floor === aisle).sort((a,b) => a.order - b.order);
        return `
          <div style="margin-bottom:16px">
            <div class="floor-hd" style="margin-bottom:8px">${currentSection}-${aisle}층</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${aisleslots.map(s => {
                const st = s.status === 'UNUSED' ? 'UNUSED' : s.item ? 'IN' : 'EMPTY';
                const baseMat = (s.material||'').split(/[(\s]/)[0];
                const matColors = MATERIAL_COLORS[baseMat];
                const bgColor = matColors ? matColors.bg : (st === 'UNUSED' ? '#e2e8f0' : '#f8fafc');
                const bdColor = matColors ? matColors.border : (st === 'UNUSED' ? '#cbd5e1' : '#e2e8f0');
                const txColor = matColors ? matColors.text : '#1c1917';
                return `
                  <div onclick="openSheet(${s.id})" style="
                    background:${bgColor};border:2px solid ${bdColor};border-radius:8px;
                    padding:8px 10px;cursor:pointer;min-width:60px;text-align:center;
                    opacity:${st === 'UNUSED' ? '0.4' : '1'};
                    box-shadow:0 1px 3px rgba(0,0,0,.06)
                  " title="${s.section}${s.floor}-${s.order}${s.item ? ' / '+s.item : ''}">
                    <div style="font-family:'IBM Plex Mono';font-weight:700;font-size:13px;color:${txColor}">${s.order}</div>
                    ${s.item ? `<div style="font-size:10px;color:${txColor};margin-top:2px;white-space:nowrap;overflow:hidden;max-width:72px;text-overflow:ellipsis">${s.item}</div>` : `<div style="font-size:10px;color:#94a3b8;margin-top:2px">${st === 'UNUSED' ? '미사용' : '공실'}</div>`}
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
  if(window.reinitMap) window.reinitMap();
}

function renderFullView(){
  const warehouse = document.getElementById('fullWarehouse');
  if(!warehouse) return;
  currentSection = null;
  const sections = [...new Set(data.map(d => d.section))].sort();
  warehouse.innerHTML = '<div class="material-legend" id="matLegend"></div><div class="wh-map"><div class="wh-map-grid" id="mapGrid"></div></div>';
  const grid = document.getElementById('mapGrid');
  const legend = document.getElementById('matLegend');
  const secMap = {};
  ['A','I','Q'].forEach(s => { if(sections.includes(s)) secMap[s] = 'sec-ai'; });
  ['B','J'].forEach(s => { if(sections.includes(s)) secMap[s] = 'sec-jp'; });
  ['C','K','L','M','N','O','P'].forEach(s => { if(sections.includes(s)) secMap[s] = 'sec-qu'; });
  ['D','E','F','G','H'].forEach(s => { if(sections.includes(s)) secMap[s] = 'sec-extra'; });
  grid.innerHTML = sections.map(sec => {
    const secSlots = data.filter(d => d.section === sec);
    const stats = { IN: 0, EMPTY: 0, UNUSED: 0 };
    secSlots.forEach(s => {
      const st = s.status === 'UNUSED' ? 'UNUSED' : s.item ? 'IN' : 'EMPTY';
      stats[st]++;
    });
    return `
      <div class="wh-map-block ${secMap[sec] || ''}" onclick="openSection('${sec}')" title="${sec}: ${stats.IN}입/${stats.EMPTY}공/${stats.UNUSED}미">${sec}</div>
    `;
  }).join('');
  legend.innerHTML = Object.entries(MATERIAL_COLORS).map(([mat, colors]) => `
    <div class="mat-chip"><div class="mat-dot" style="background:${colors.bg}"></div>${mat}</div>
  `).join('');
}

function handleQRParam(){
  const params = new URLSearchParams(window.location.search);
  const slot = params.get('slot');
  if(!slot) return;
  const d = data.find(d => `${d.section}${d.floor}-${d.order}` === slot);
  if(d){
    switchTab('full');
    setTimeout(() => { openSection(d.section); setTimeout(() => openSheet(d.id), 300); }, 300);
  }
}

function pqSwitchMode(mode){
  document.getElementById('pqModeQueue').style.display = mode === 'queue' ? 'block' : 'none';
  document.getElementById('pqModeLabel').style.display = mode === 'label' ? 'block' : 'none';
  document.getElementById('pqTabQueue').classList.toggle('on', mode === 'queue');
  document.getElementById('pqTabLabel').classList.toggle('on', mode === 'label');
  if(mode === 'label') renderLabels();
}

function renderLabels(){
  const secSelect = document.getElementById('lblSec');
  const size = document.querySelector('input[name="lblSz"]:checked')?.value || 'md';
  const sec = secSelect.value;
  const preview = document.getElementById('lblPreview');
  const sections = sec === 'all' ? [...new Set(data.map(d => d.section))].sort() : [sec];
  const slots = data.filter(d => sections.includes(d.section) && d.item);
  preview.innerHTML = slots.map(d => {
    const baseMat = (d.material || '').split(/[(\s]/)[0];
    const colors = MATERIAL_COLORS[baseMat];
    const bgColor = colors ? colors.bg : '#e8e4de';
    const matColor = colors ? colors.text : '#111';
    const loc = `${d.section}${d.floor}-${d.order}`;
    return `
      <div class="lbl-card ${size}">
        <div class="lbl-left" style="background:${bgColor}">
          <div class="lbl-loc">${loc}</div>
          <div class="lbl-matname">${d.material}</div>
        </div>
        <div class="lbl-right">
          <div class="lbl-info">
            <div class="lbl-item">${d.item}</div>
            <div class="lbl-type">${d.material}</div>
          </div>
          <div class="lbl-qr" data-slot="${loc}"></div>
        </div>
      </div>
    `;
  }).join('');
  document.getElementById('lblCount').textContent = slots.length + '개';
  setTimeout(() => {
    document.querySelectorAll('.lbl-qr').forEach(card => {
      const loc = card.dataset.slot;
      const baseUrl = window.location.href.split('?')[0];
      try {
        new QRCode(card, { text: baseUrl + '?slot=' + encodeURIComponent(loc), width: 200, height: 200, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
      } catch(e) {}
    });
  }, 100);
}

function printQueueLabels(){
  const wrap = document.getElementById('pqList');
  if(!wrap || !printQueue.length) { showToast('인쇄할 항목이 없습니다'); return; }
  const area = document.getElementById('pqPrintArea');
  area.innerHTML = printQueue.map((item, idx) => {
    const baseMat = (item.material || '').split(/[(\s]/)[0];
    const colors = MATERIAL_COLORS[baseMat];
    const bgColor = colors ? colors.bg : '#e8e4de';
    return `
      <div class="pq-label">
        <div class="pq-label-loc">${item.loc}</div>
        <div class="pq-label-qr" data-item="${item.loc}"></div>
        <div class="pq-label-info">
          <div class="pq-label-item">${item.item}</div>
          <div class="pq-label-mat">${item.material}</div>
        </div>
        <div class="pq-label-cb" style="background:${bgColor}"></div>
      </div>
    `;
  }).join('');
  setTimeout(() => {
    document.querySelectorAll('.pq-label-qr').forEach(card => {
      const loc = card.dataset.item;
      const baseUrl = window.location.href.split('?')[0];
      try {
        new QRCode(card, { text: baseUrl + '?slot=' + encodeURIComponent(loc), width: 80, height: 80, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
      } catch(e) {}
    });
    window.print();
  }, 200);
}

function printLabels(){
  const wrap = document.getElementById('lblPreview');
  if(!wrap.children.length) { showToast('인쇄할 라벨이 없습니다'); return; }
  const area = document.getElementById('pqPrintArea');
  area.innerHTML = wrap.innerHTML;
  area.style.display = 'block';
  document.querySelectorAll('.panel,.topbar,.tabbar,.sheet-backdrop,.sheet,.popup-backdrop,.slot-popup,.toast,.search-result-panel').forEach(el => {
    el.dataset.pqHide = el.style.display || '';
    el.style.display = 'none';
  });
  setTimeout(() => {
    window.print();
    setTimeout(() => {
      document.querySelectorAll('[data-pq-hide]').forEach(el => {
        el.style.display = el.dataset.pqHide;
        delete el.dataset.pqHide;
      });
      area.style.display = 'none';
    }, 500);
  }, 300);
}

function renderAll(){
  renderOverviewGrid();
  renderTableView();
  renderPrintQueue();
  renderFullView();
}

async function initialize(){
  await initData();
  loadFromCache();
  loadShipmentData();
  renderAll();
  loadFromSheet().then(() => loadShipmentData());
  handleQRParam();
}

window.addEventListener('DOMContentLoaded', initialize);
