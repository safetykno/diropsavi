// ═══════════════════════════════════════════════════
// FIREBASE + LOCALSTORAGE HYBRID STORAGE
// ═══════════════════════════════════════════════════
const LS_KEY       = 'dirops_v1_data';
const LS_CFG_KEY   = 'ikera_firebase_config';
const FB_PATH      = 'ikera/data';
const SESSION_KEY  = 'dirops_session';

// ════════════════════════════════════════════════
// AUTH & SESSION
// ════════════════════════════════════════════════
let currentUser = null; // {id, name, email, role, unit, isAdmin}

function getSession(){
  try{ return JSON.parse(sessionStorage.getItem(SESSION_KEY)||'null'); }
  catch(e){ return null; }
}
function setSession(u){
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(u));
}
function clearSession(){
  sessionStorage.removeItem(SESSION_KEY);
}



function ensureAdminUser(){
  // Admin default harus selalu ada dan tidak bisa dihapus
  const existing = DB.users.find(u=>u.isAdmin===true);
  if(!existing){
    DB.users.unshift({id:'admin',name:'Administrator',email:'safety@avi.id',role:'Admin',unit:'All Units',phone:'',last:'Today',status:'Active',password:'admin123',isAdmin:true});
  }
}

function toggleLoginPw(){
  const inp=document.getElementById('login-pass');
  const eye=document.getElementById('pw-eye');
  if(inp.type==='password'){inp.type='text';eye.className='fa fa-eye-slash';}
  else{inp.type='password';eye.className='fa fa-eye';}
}



function showApp(){
  // Hide login, show app
  document.getElementById('login-screen').style.display='none';
  document.querySelector('.sidebar').style.visibility='';
  document.querySelector('.main').style.visibility='';

  // Update sidebar user info
  const ini=(currentUser.name||'').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('sidebar-av').textContent=ini;
  document.getElementById('sidebar-name').textContent=currentUser.name;
  document.getElementById('sidebar-role').textContent=currentUser.isAdmin?'Administrator':currentUser.role+' · '+currentUser.unit;

  // Build nav based on permissions
  buildNavFromPermissions();
}

// ── Permission helpers ──
// 0=no access, 1=view only, 2=edit
function getPerm(mod){
  if(!currentUser) return 0;
  if(currentUser.isAdmin) return 2; // Admin full access
  const perms = DB.rolePermissions[currentUser.role]||{};
  return perms[mod]||0;
}
function canView(mod){ return getPerm(mod)>=1; }
function canEdit(mod){ return getPerm(mod)>=2; }

// Map view name → module name
const VIEW_MODULE_MAP={
  dashboard:'Dashboard',kpi:'KPI Management',program:'Program Kerja',
  risk:'Risk & EWS',procurement:'Pengadaan',asset:'Asset & CMMS',
  audit:'Finding',license:'Lisensi & SOP',units:'User Management',
  users:'User Management',settings:'Settings',integrated:'Program Kerja',
};

function buildNavFromPermissions(){
  document.querySelectorAll('.nav-item[data-view]').forEach(el=>{
    const view=el.dataset.view;
    const mod=VIEW_MODULE_MAP[view]||view;
    const perm=getPerm(mod);
    el.style.display=perm===0?'none':'flex';
    // Add view-only badge
    const existBadge=el.querySelector('.view-only-badge');
    if(existBadge) existBadge.remove();
    if(perm===1){
      const vb=document.createElement('span');
      vb.className='view-only-badge';
      vb.style.cssText='margin-left:auto;font-size:8px;color:var(--warn);background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);border-radius:4px;padding:1px 4px;white-space:nowrap';
      vb.textContent='View';
      el.appendChild(vb);
    }
  });
}

// Guard: block edit actions for view-only users
function guardEdit(mod){
  if(!canEdit(mod)){
    alert(`Anda hanya memiliki akses View pada modul "${mod}". Hubungi Administrator untuk akses Edit.`);
    return false;
  }
  return true;
}

let fbApp = null;
let fbDb  = null;
let fbConnected = false;
let _saveTimer  = null;

// ── Ambil config Firebase (tersimpan di localStorage) ──
function getFirebaseConfig(){
  try{ return JSON.parse(localStorage.getItem(LS_CFG_KEY)||'null'); }
  catch(e){ return null; }
}
function saveFirebaseConfig(cfg){
  localStorage.setItem(LS_CFG_KEY, JSON.stringify(cfg));
}

// ── Init Firebase ──
function initFirebase(cfg){
  try{
    if(fbApp) fbApp.delete().catch(()=>{});
    fbApp = firebase.initializeApp(cfg, 'ikera-'+Date.now());
    fbDb  = fbApp.database();
    // Test koneksi
    fbDb.ref('.info/connected').on('value', snap=>{
      fbConnected = !!snap.val();
      updateConnectionBadge();
    });
    // Realtime listener — update lokal jika ada perubahan dari luar
    fbDb.ref(FB_PATH).on('value', snap=>{
      const remote = snap.val();
      if(!remote) return;
      if(remote._saved && DB._lastSave && remote._saved === DB._lastSave) return; // perubahan dari kita sendiri
      const ts = remote._saved||'';
      delete remote._saved;
      Object.assign(DB, remote);
      DB._lastSave = ts;
      syncKPIsFromPrograms();
      autoCheckAuditOverdue();
      autoCheckLicenseStatus();
      updateBadges();
      // Re-render view aktif
      const rv = {dashboard:renderDashboard,integrated:renderIntegrated,kpi:renderKPI,program:renderProgram,risk:renderRisk,procurement:renderProcurement,asset:renderAsset,audit:renderAudit,license:renderLicense,units:renderUnits,users:renderUsers,settings:renderSettings};
      if(rv[currentView]) { destroyCharts(); rv[currentView](); }
    });
    return true;
  }catch(e){
    console.error('Firebase init error:', e);
    fbConnected = false;
    updateConnectionBadge();
    return false;
  }
}

// ── Save ke Firebase ──
async function saveToFirebase(){
  if(!fbDb || !fbConnected) return false;
  try{
    const ts = new Date().toISOString();
    DB._lastSave = ts;
    const payload = {...DB, _saved: ts};
    delete payload.kpis; // kpis di-generate, tidak perlu disimpan
    await fbDb.ref(FB_PATH).set(payload);
    return true;
  }catch(e){
    console.warn('Firebase save error:', e);
    return false;
  }
}

// ── Load dari Firebase (sekali, saat init) ──
async function loadFromFirebase(){
  if(!fbDb) return false;
  try{
    const snap = await fbDb.ref(FB_PATH).once('value');
    const remote = snap.val();
    if(!remote) return false;
    const ts = remote._saved||'';
    delete remote._saved;
    Object.assign(DB, remote);
    DB._lastSave = ts;
    return true;
  }catch(e){
    console.warn('Firebase load error:', e);
    return false;
  }
}

// ── localStorage sebagai cache offline ──
function saveToLocalStorage(){
  try{
    const payload = JSON.stringify({...DB, _saved: new Date().toISOString()});
    localStorage.setItem(LS_KEY, payload);
  }catch(e){}
}

function loadFromLocalStorage(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return false;
    const saved = JSON.parse(raw);
    if(!saved.programs||!saved.units) return false;
    delete saved._saved;
    Object.assign(DB, saved);
    return true;
  }catch(e){ return false; }
}

// ── Master save: Firebase + localStorage ──
function scheduleSave(){
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async ()=>{
    saveToLocalStorage();              // selalu simpan lokal
    const ok = await saveToFirebase(); // coba simpan ke Firebase
    showSaveIndicator(ok);
  }, 600);
}

function showSaveIndicator(firebaseOk){
  const el = document.getElementById('save-indicator');
  if(!el) return;
  if(firebaseOk){
    el.innerHTML = '<i class="fa fa-cloud" style="color:var(--success)"></i> Tersimpan';
    el.style.color = 'var(--success)';
  } else {
    el.innerHTML = '<i class="fa fa-hard-drive" style="color:var(--warn)"></i> Lokal saja';
    el.style.color = 'var(--warn)';
  }
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ el.style.opacity='0'; }, 3000);
}

// ── Badge koneksi di topbar ──
function updateConnectionBadge(){
  const el = document.getElementById('fb-status');
  if(!el) return;
  if(!getFirebaseConfig()){
    el.innerHTML = '<i class="fa fa-plug-circle-exclamation" style="color:var(--t3)"></i>';
    el.title = 'Firebase belum dikonfigurasi';
  } else if(fbConnected){
    el.innerHTML = '<i class="fa fa-cloud" style="color:var(--success)"></i>';
    el.title = 'Firebase terhubung';
  } else {
    el.innerHTML = '<i class="fa fa-cloud-slash" style="color:var(--danger)"></i>';
    el.title = 'Firebase tidak terhubung — data disimpan lokal';
  }
}

function clearLocalStorage(){
  if(!confirm('Reset semua data ke kondisi awal (default)? Semua perubahan akan hilang.')) return;
  localStorage.removeItem(LS_KEY);
  location.reload();
}

async function disconnectAndResetFirebase(){
  if(!confirm('Hapus konfigurasi Firebase? Aplikasi akan kembali ke mode offline (localStorage).')) return;
  localStorage.removeItem(LS_CFG_KEY);
  if(fbDb) fbDb.ref(FB_PATH).off();
  fbApp = null; fbDb = null; fbConnected = false;
  updateConnectionBadge();
  renderSettings();
  alert('Konfigurasi Firebase dihapus. Aplikasi kini dalam mode offline.');
}

// ═══════════════ DATABASE ═══════════════
let DB = {
  divisions: ['Electronic Facility','Infrastructure','Electrical & Mechanical Facility','Airport Rescue & Firefighting','Airport & Security','Airport Operation & Service','Safety & Quality Control'],
  units: [
    // Electronic Facility
    {id:'u1',name:'Airport IT',code:'AIT',head:'—',email:'',color:'#1a8cff',divisi:'Electronic Facility',members:0,desc:'Airport Information Technology',loc:'—'},
    {id:'u2',name:'General Electronic Facility',code:'GEF',head:'—',email:'',color:'#00d4ff',divisi:'Electronic Facility',members:0,desc:'General Electronic Facility',loc:'—'},
    {id:'u3',name:'Safety & Security Facility',code:'SSF',head:'—',email:'',color:'#0099cc',divisi:'Electronic Facility',members:0,desc:'Safety & Security Facility',loc:'—'},
    // Infrastructure
    {id:'u4',name:'Runway & Airfield',code:'RWA',head:'—',email:'',color:'#22c55e',divisi:'Infrastructure',members:0,desc:'Runway & Airfield',loc:'—'},
    {id:'u5',name:'Building Maintenance',code:'BMT',head:'—',email:'',color:'#16a34a',divisi:'Infrastructure',members:0,desc:'Building Maintenance',loc:'—'},
    {id:'u6',name:'Accessibility & Environment',code:'ACE',head:'—',email:'',color:'#4ade80',divisi:'Infrastructure',members:0,desc:'Accessibility & Environment',loc:'—'},
    // Electrical & Mechanical Facility
    {id:'u7',name:'Energy & Power Supply',code:'EPS',head:'—',email:'',color:'#f59e0b',divisi:'Electrical & Mechanical Facility',members:0,desc:'Energy & Power Supply',loc:'—'},
    {id:'u8',name:'Electrical Facility',code:'ELF',head:'—',email:'',color:'#fbbf24',divisi:'Electrical & Mechanical Facility',members:0,desc:'Electrical Facility',loc:'—'},
    {id:'u9',name:'Mechanical Facility',code:'MEF',head:'—',email:'',color:'#f97316',divisi:'Electrical & Mechanical Facility',members:0,desc:'Mechanical Facility',loc:'—'},
    {id:'u10',name:'Airport Equipment',code:'AEQ',head:'—',email:'',color:'#ea580c',divisi:'Electrical & Mechanical Facility',members:0,desc:'Airport Equipment',loc:'—'},
    // Airport Rescue & Firefighting
    {id:'u11',name:'RFF Operation',code:'RFF',head:'—',email:'',color:'#ff3b3b',divisi:'Airport Rescue & Firefighting',members:0,desc:'RFF Operation',loc:'—'},
    {id:'u12',name:'RFF Exercise & Facility',code:'REF',head:'—',email:'',color:'#dc2626',divisi:'Airport Rescue & Firefighting',members:0,desc:'RFF Exercise & Facility',loc:'—'},
    // Airport & Security
    {id:'u13',name:'Aviation Security',code:'AVSEC',head:'—',email:'',color:'#a855f7',divisi:'Airport & Security',members:0,desc:'Aviation Security',loc:'—'},
    {id:'u14',name:'Public Security',code:'PUBSEC',head:'—',email:'',color:'#7c3aed',divisi:'Airport & Security',members:0,desc:'Public Security',loc:'—'},
    // Airport Operation & Service
    {id:'u15',name:'Landside Service',code:'LDS',head:'—',email:'',color:'#14b8a6',divisi:'Airport Operation & Service',members:0,desc:'Landside Service',loc:'—'},
    {id:'u16',name:'Terminal & Passenger Service',code:'TPS',head:'—',email:'',color:'#0d9488',divisi:'Airport Operation & Service',members:0,desc:'Terminal & Passenger Service',loc:'—'},
    {id:'u17',name:'Airside Operation',code:'ARSD',head:'—',email:'',color:'#2dd4bf',divisi:'Airport Operation & Service',members:0,desc:'Airside Operation',loc:'—'},
    // Safety & Quality Control
    {id:'u18',name:'Service Quality',code:'SQC',head:'—',email:'',color:'#ec4899',divisi:'Safety & Quality Control',members:0,desc:'Service Quality',loc:'—'},
    {id:'u19',name:'Safety',code:'SAFE',head:'—',email:'',color:'#db2777',divisi:'Safety & Quality Control',members:0,desc:'Safety',loc:'—'},
    {id:'u20',name:'RFF Quality',code:'RFFQ',head:'—',email:'',color:'#f43f5e',divisi:'Safety & Quality Control',members:0,desc:'RFF Quality',loc:'—'},
    {id:'u21',name:'Security Quality',code:'SECQ',head:'—',email:'',color:'#e11d48',divisi:'Safety & Quality Control',members:0,desc:'Security Quality',loc:'—'},
    {id:'u22',name:'Maintenance Quality',code:'MNTQ',head:'—',email:'',color:'#9f1239',divisi:'Safety & Quality Control',members:0,desc:'Maintenance Quality',loc:'—'},
    {id:'u23',name:'Airport Data Management',code:'ADM',head:'—',email:'',color:'#be185d',divisi:'Safety & Quality Control',members:0,desc:'Airport Data Management',loc:'—'},
  ],
  programs: [
    {id:'p1',name:'Revamping Sistem Pendingin',unitId:'u9',pic:'—',start:'2025-01-01',end:'2025-06-30',budget:500,spent:320,useAsKPI:true,kpiTarget:100,kpiWeight:20,riskId:'r1',desc:'Overhaul sistem pendingin pabrik 1',progress:64,status:'On Track',
     tasks:[{id:'t1',text:'Survey kondisi existing',done:true},{id:'t2',text:'Desain sistem baru',done:true},{id:'t3',text:'Pengadaan material',done:true},{id:'t4',text:'Instalasi',done:false},{id:'t5',text:'Commissioning',done:false},{id:'t6',text:'Dokumentasi',done:false}]},
    {id:'p2',name:'Audit Keuangan Q2',unitId:'u18',pic:'—',start:'2025-04-01',end:'2025-04-30',budget:50,spent:50,useAsKPI:true,kpiTarget:100,kpiWeight:15,riskId:'',desc:'Audit internal keuangan Q2',progress:100,status:'On Track',
     tasks:[{id:'t1',text:'Persiapan dokumen',done:true},{id:'t2',text:'Pelaksanaan audit',done:true},{id:'t3',text:'Laporan',done:true}]},
    {id:'p3',name:'Safety Training Semua Unit',unitId:'u19',pic:'—',start:'2025-03-01',end:'2025-05-31',budget:80,spent:65,useAsKPI:true,kpiTarget:95,kpiWeight:10,riskId:'r2',desc:'Training K3 seluruh karyawan',progress:75,status:'At Risk',
     tasks:[{id:'t1',text:'Modul training',done:true},{id:'t2',text:'Jadwal peserta',done:true},{id:'t3',text:'Pelaksanaan batch 1',done:true},{id:'t4',text:'Pelaksanaan batch 2',done:false},{id:'t5',text:'Evaluasi & sertifikat',done:false}]},
  ],
  kpis:[],
  risks:[
    {id:'r1',cat:'Operational',desc:'Kegagalan sistem pendingin produksi',cause:'Usia peralatan >10 tahun',impact:4,likelihood:4,mitigation:'Percepat revamping',pic:'Unit Teknik',due:'2025-06-30',status:'Open',progId:'p1'},
    {id:'r2',cat:'HSE',desc:'Kecelakaan kerja akibat kurang training',cause:'Training tidak terjadwal',impact:3,likelihood:3,mitigation:'Program safety training rutin',pic:'Unit Safety',due:'2025-05-31',status:'Mitigated',progId:'p3'},
    {id:'r3',cat:'Financial',desc:'Budget overrun proyek revamping',cause:'Estimasi tidak akurat',impact:3,likelihood:2,mitigation:'Review budget mingguan',pic:'Unit Quality',due:'2025-06-30',status:'Open',progId:''},
  ],
  ews:[
    {id:'e1',desc:'Sistem pendingin Line 2 suhu naik 5°C dari batas',cat:'Operational',level:'High',trigger:'Sensor temp > threshold',time:'10:23 WIB',assigned:'Unit Mechanical',acked:false,auto:true},
    {id:'e2',desc:'Realisasi KPI Safety Training < 80% dari target',cat:'KPI',level:'Medium',trigger:'KPI < 80%',time:'08:00 WIB',assigned:'Unit Safety',acked:false,auto:true},
  ],
  procurement:[
    {id:'po1',item:'Mechanical Seal Pump P-101',vendor:'PT Mitra Teknik',unitId:'u9',value:45,date:'2025-01-10',due:'2025-02-10',delay:0,status:'Delivered',stage:'Complete',note:'Sudah dipasang',
     tasks:[{id:'t1',text:'Proses PR',done:true},{id:'t2',text:'Tender/Penunjukan',done:true},{id:'t3',text:'PO diterbitkan',done:true},{id:'t4',text:'Delivery',done:true},{id:'t5',text:'Inspeksi',done:true},{id:'t6',text:'Pembayaran',done:true}]},
    {id:'po2',item:'Bearing Set Conveyor C-05',vendor:'PT Abadi Parts',unitId:'u9',value:18,date:'2025-03-01',due:'2025-04-15',delay:12,status:'In Transit',stage:'Delivery',note:'Delay pengiriman dari vendor',
     tasks:[{id:'t1',text:'Proses PR',done:true},{id:'t2',text:'Tender/Penunjukan',done:true},{id:'t3',text:'PO diterbitkan',done:true},{id:'t4',text:'Delivery',done:false},{id:'t5',text:'Inspeksi',done:false},{id:'t6',text:'Pembayaran',done:false}]},
  ],
  assets:[
    {id:'a1',code:'A-001',name:'Kompresor Udara KU-01',cat:'Rotating Equipment',loc:'Pabrik 1',year:2015,value:850,life:15,vendor:'PT Industri Jaya',crit:'Critical',certStatus:'Valid',certExpiry:'2025-12-31',
     maintenances:[{date:'2025-01-15',type:'Preventive',tech:'Budi',cost:5,note:'Ganti filter',status:'Done'},{date:'2025-03-10',type:'Corrective',tech:'Andi',cost:12,note:'Perbaiki seal',status:'Done'}],
     repairHistory:[{date:'2024-06-01',desc:'Perbaikan bearing',cost:25},{date:'2024-11-20',desc:'Ganti piston ring',cost:45}],
     issues:'Getaran abnormal pada RPM tinggi',schedMaint:'2025-06-15',
     repairAnalysis:{totalRepair:70,ratio:8.2,recommend:'Monitor',reasons:'Rasio repair/value masih di bawah 15%, lanjutkan perawatan preventif'}},
    {id:'a2',code:'A-002',name:'Pompa Sentrifugal P-101',cat:'Rotating Equipment',loc:'Pabrik 1',year:2012,value:320,life:20,vendor:'PT Pump Indo',crit:'High',certStatus:'Near Expiry',certExpiry:'2025-07-01',
     maintenances:[{date:'2025-02-20',type:'Preventive',tech:'Eko',cost:3,note:'Ganti seal kit',status:'Done'}],
     repairHistory:[{date:'2023-08-15',desc:'Rewind motor',cost:85},{date:'2024-04-10',desc:'Ganti impeller',cost:95}],
     issues:'Kebocoran seal minor di sisi discharge',schedMaint:'2025-05-30',
     repairAnalysis:{totalRepair:180,ratio:56.3,recommend:'Replace',reasons:'Rasio repair/value >50%, umur >12 tahun, disarankan penggantian'}},
  ],
  auditTypes:['Internal Audit','External Audit','HSE Audit','Financial Audit','Compliance Audit'],
  audit:[
    {id:'A-001',unit:'u19',type:'HSE Audit',judul:'Kelengkapan APD di area produksi',sev:'Major',owner:'Ahmad Fauzi',due:'2025-05-30',status:'Open',
     tasks:[{id:'t1',text:'Inventarisasi APD tersedia',done:true},{id:'t2',text:'Identifikasi kekurangan',done:true},{id:'t3',text:'Pengadaan APD',done:false},{id:'t4',text:'Distribusi ke karyawan',done:false},{id:'t5',text:'Verifikasi pemakaian',done:false}]},
    {id:'A-002',unit:'u9',type:'Internal Audit',judul:'Dokumentasi prosedur maintenance belum lengkap',sev:'Minor',owner:'Rina Wijaya',due:'2025-04-15',status:'Overdue',
     tasks:[{id:'t1',text:'List prosedur yang ada',done:true},{id:'t2',text:'Identifikasi gap',done:true},{id:'t3',text:'Penyusunan SOP',done:false}]},
    {id:'A-003',unit:'u18',type:'Financial Audit',judul:'Rekonsiliasi akun hutang',sev:'Critical',owner:'Sari Dewi',due:'2025-06-01',status:'In Progress',
     tasks:[{id:'t1',text:'Download data hutang',done:true},{id:'t2',text:'Rekonsiliasi manual',done:false},{id:'t3',text:'Konfirmasi vendor',done:false},{id:'t4',text:'Laporan',done:false}]},
  ],
  licenses:[
    {id:'l1',type:'Peralatan',name:'Sertifikat Boiler B-01',issuer:'Kemnaker RI',unit:'u9',holder:'PT AVI',issued:'2023-01-15',expiry:'2025-07-15',status:'Near Expiry',notes:'Perlu perpanjangan segera'},
    {id:'l2',type:'SOP',name:'SOP Operasi Kompresor KU-01',issuer:'Internal',unit:'u9',holder:'Unit Mechanical',issued:'2024-01-01',expiry:'2026-01-01',status:'Valid',notes:'Review tahunan'},
    {id:'l3',type:'Personil',name:'Sertifikat Operator K3',issuer:'BNSP',unit:'u19',holder:'Unit Safety',issued:'2022-06-01',expiry:'2025-06-01',status:'Near Expiry',notes:'Jadwal ulang sertifikasi'},
    {id:'l4',type:'Personil',name:'Sertifikat Welder Kelas 1',issuer:'Kemnaker RI',unit:'u9',holder:'Unit RFF',issued:'2021-03-01',expiry:'2024-03-01',status:'Expired',notes:'EXPIRED — harus diperbaharui'},
    {id:'l5',type:'Peralatan',name:'Kalibrasi Pressure Gauge',issuer:'KAN',unit:'u9',holder:'PT AVI',issued:'2024-09-01',expiry:'2025-09-01',status:'Valid',notes:'Kalibrasi rutin tahunan'},
  ],
  users:[
    {id:'admin',name:'Administrator',email:'safety@avi.id',role:'Admin',unit:'All Units',phone:'',last:'Today',status:'Active',password:'admin123',isAdmin:true},
    {id:'u001',name:'Ahmad Santoso',email:'ahmad.s@aviasi.co.id',role:'Director',unit:'All Units',phone:'',last:'Today',status:'Active',password:'password'},
    {id:'u002',name:'Budi Kusuma',email:'budi.k@aviasi.co.id',role:'General Manager',unit:'All Units',phone:'',last:'Today',status:'Active',password:'password'},
    {id:'u003',name:'Sari Dewi',email:'sari.d@aviasi.co.id',role:'Manager',unit:'Unit Keuangan',phone:'',last:'Yesterday',status:'Active',password:'password'},
    {id:'u004',name:'Ahmad Fauzi',email:'a.fauzi@aviasi.co.id',role:'Supervisor',unit:'Unit HSE',phone:'',last:'Today',status:'Active',password:'password'},
    {id:'u005',name:'Rina Wijaya',email:'rina.w@aviasi.co.id',role:'Viewer',unit:'Unit Teknik',phone:'',last:'2 days ago',status:'Active',password:'password'},
  ],
  roles:['Director','General Manager','Manager','Supervisor','Staff','Viewer'],
  rolePermissions:{
    // 0 = No Access, 1 = View Only, 2 = View & Edit
    'Director':       {Dashboard:2,'KPI Management':2,'Program Kerja':2,'Risk & EWS':2,'Pengadaan':2,'Asset & CMMS':2,'Finding':2,'Lisensi & SOP':2,'User Management':2,'Settings':2},
    'General Manager':{Dashboard:2,'KPI Management':2,'Program Kerja':2,'Risk & EWS':2,'Pengadaan':2,'Asset & CMMS':2,'Finding':2,'Lisensi & SOP':2,'User Management':2,'Settings':1},
    'Manager':        {Dashboard:2,'KPI Management':2,'Program Kerja':2,'Risk & EWS':2,'Pengadaan':2,'Asset & CMMS':2,'Finding':2,'Lisensi & SOP':2,'User Management':1,'Settings':1},
    'Supervisor':     {Dashboard:2,'KPI Management':1,'Program Kerja':2,'Risk & EWS':1,'Pengadaan':2,'Asset & CMMS':2,'Finding':2,'Lisensi & SOP':1,'User Management':0,'Settings':0},
    'Staff':          {Dashboard:1,'KPI Management':1,'Program Kerja':2,'Risk & EWS':0,'Pengadaan':2,'Asset & CMMS':1,'Finding':1,'Lisensi & SOP':1,'User Management':0,'Settings':0},
    'Viewer':         {Dashboard:1,'KPI Management':1,'Program Kerja':1,'Risk & EWS':1,'Pengadaan':1,'Asset & CMMS':1,'Finding':1,'Lisensi & SOP':1,'User Management':0,'Settings':0},
  }
};

// ═══════════════ UTILITIES ═══════════════
let currentView='dashboard', activeCharts=[];
function today(){return new Date().toISOString().split('T')[0];}
function fmtDate(d){if(!d)return '—';const dt=new Date(d);return isNaN(dt)?d:dt.toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'});}
function daysLeft(due){if(!due)return null;return Math.ceil((new Date(due)-new Date())/86400000);}
function isOverdue(due){const d=daysLeft(due);return d!==null&&d<0;}
function uid(){return 'id'+Date.now()+Math.random().toString(36).slice(2,6);}
function unitName(id){const u=DB.units.find(x=>x.id===id);return u?u.name:'—';}
function unitColor(id){const u=DB.units.find(x=>x.id===id);return u?u.color:'#888';}
function progColor(p){return p>=80?'var(--success)':p>=50?'var(--warn)':'var(--danger)';}
// ── Task weight helpers ──
function ensureWeights(tasks){
  if(!tasks||!tasks.length) return;
  const hasWeights = tasks.some(t=>t.weight!=null&&t.weight>0);
  if(!hasWeights){
    // Auto-distribute evenly
    const w = Math.floor(100/tasks.length);
    const rem = 100 - w*tasks.length;
    tasks.forEach((t,i)=>{ t.weight = w + (i===0?rem:0); });
  }
}

function updateTaskWeight(col, id, tid, val){
  let obj = col==='programs'?DB.programs.find(x=>x.id===id):col==='procurement'?DB.procurement.find(x=>x.id===id):DB.audit.find(x=>x.id===id);
  if(!obj) return;
  const t = obj.tasks.find(x=>x.id===tid);
  if(t) t.weight = Math.max(0, Math.min(100, parseInt(val)||0));
  if(col==='programs'){ obj.progress=recalcProgressFromTasks(obj); syncKPIsFromPrograms(); }
  const block = document.getElementById('taskblock-'+id);
  if(block) block.innerHTML = buildTasksHTML(obj.tasks, id, col);
  scheduleSave();
}

function updateTaskDue(col,id,tid,val){
  let obj=col==='programs'?DB.programs.find(x=>x.id===id):col==='procurement'?DB.procurement.find(x=>x.id===id):DB.audit.find(x=>x.id===id);
  if(!obj)return;
  const t=obj.tasks.find(x=>x.id===tid); if(t) t.due=val;
  const block=document.getElementById('taskblock-'+id);
  if(block) block.innerHTML=buildTasksHTML(obj.tasks,id,col);
  scheduleSave();
}

function autoDistributeWeights(col, id){
  let obj = col==='programs'?DB.programs.find(x=>x.id===id):col==='procurement'?DB.procurement.find(x=>x.id===id):DB.audit.find(x=>x.id===id);
  if(!obj||!obj.tasks||!obj.tasks.length) return;
  const w = Math.floor(100/obj.tasks.length);
  const rem = 100 - w*obj.tasks.length;
  obj.tasks.forEach((t,i)=>{ t.weight = w + (i===0?rem:0); });
  if(col==='programs'){ obj.progress=recalcProgressFromTasks(obj); syncKPIsFromPrograms(); }
  const block = document.getElementById('taskblock-'+id);
  if(block) block.innerHTML = buildTasksHTML(obj.tasks, id, col);
  scheduleSave();
}

function recalcProgressFromTasks(p){
  if(!p.tasks||!p.tasks.length) return p.progress||0;
  ensureWeights(p.tasks);
  const totalW = p.tasks.reduce((s,t)=>s+(t.weight||0),0);
  if(totalW===0) return Math.round(p.tasks.filter(t=>t.done).length/p.tasks.length*100);
  const doneW = p.tasks.reduce((s,t)=>s+(t.done?(t.weight||0):0),0);
  return Math.round(doneW/totalW*100);
}

// ════════════════════════════════════════════════
// SINKRONISASI BIDIREKSIONAL: Pengadaan ↔ Program Kerja
// ════════════════════════════════════════════════

function syncPOToProgram(poId){
  const po=DB.procurement.find(x=>x.id===poId); if(!po||!po.progId) return;
  const prog=DB.programs.find(x=>x.id===po.progId); if(!prog) return;
  prog.name='[Pengadaan] '+po.item;
  prog.pic=po.vendor||prog.pic;
  prog.unitId=po.unitId||prog.unitId;
  prog.budget=po.budget||po.value||prog.budget;
  prog.spent=po.spent||0;
  prog.end=po.due||prog.end;
  prog.status=po.status==='Delivered'?'On Track':po.delay>0?'Overdue':prog.status==='Completed'?'Completed':'In Progress';
  prog.tasks=po.tasks; // task list sama persis
  prog.progress=recalcProgressFromTasks(prog);
}

function syncProgramToPO(progId){
  const prog=DB.programs.find(x=>x.id===progId); if(!prog||!prog.fromPO) return;
  const po=DB.procurement.find(x=>x.id===prog.fromPO); if(!po) return;
  po.item=prog.name.replace(/^\[Pengadaan\]\s*/,'');
  po.vendor=prog.pic||po.vendor;
  po.unitId=prog.unitId||po.unitId;
  po.budget=prog.budget||po.budget;
  po.value=prog.budget||po.value;
  po.spent=prog.spent||0;
  po.due=prog.end||po.due;
  po.status=prog.status==='On Track'?'In Progress':prog.status==='Completed'?'Delivered':prog.status==='Overdue'?'In Progress':po.status;
  po.tasks=prog.tasks; // task list sama persis
}

function syncKPIsFromPrograms(){
  // Auto-update overdue status for programs
  DB.programs.forEach(p=>{
    if(p.end && isOverdue(p.end) && p.status!=='On Track'&&p.status!=='Completed'){
      p.status='Overdue';
    }
  });
  // Auto-update overdue status for procurement
  DB.procurement.forEach(po=>{
    if(po.due && isOverdue(po.due) && po.status==='In Progress' && !po.delay){
      po.delay = Math.abs(daysLeft(po.due)||0);
    }
  });
  DB.kpis=DB.programs.filter(p=>p.useAsKPI).map(p=>{
    const u=DB.units.find(x=>x.id===p.unitId);
    const pr=recalcProgressFromTasks(p);p.progress=pr;
    return {id:p.id,name:p.name,unitId:p.unitId,unit:u?u.name:'—',target:p.kpiTarget||100,real:pr,weight:p.kpiWeight||10,period:'May 2025',pic:p.pic,fromProgram:true};
  });
}
function autoCheckAuditOverdue(){DB.audit.forEach(a=>{if(a.status!=='Completed'&&a.status!=='Close'&&a.due&&daysLeft(a.due)<0)a.status='Overdue';});}
function autoCheckLicenseStatus(){DB.licenses.forEach(l=>{const d=daysLeft(l.expiry);if(d===null)return;if(d<0)l.status='Expired';else if(d<=180)l.status='Near Expiry';else l.status='Valid';});}
function updateBadges(){
  const e=DB.ews.filter(x=>!x.acked).length,a=DB.audit.filter(x=>x.status==='Open'||x.status==='Overdue').length,l=DB.licenses.filter(x=>x.status!=='Valid').length;
  const be=document.getElementById('badge-ews'),ba=document.getElementById('badge-audit'),bl=document.getElementById('badge-lic');
  be.textContent=e;be.style.display=e?'':'none';
  ba.textContent=a;ba.style.display=a?'':'none';
  bl.textContent=l;bl.style.display=l?'':'none';
}
function destroyCharts(){activeCharts.forEach(c=>{try{c.destroy()}catch(e){}});activeCharts=[];}

// ═══════════════ NAVIGATION ═══════════════
const VIEW_TITLES={dashboard:'Executive Dashboard',integrated:'Input Terintegrasi',kpi:'KPI Management',program:'Program Kerja',risk:'Risk Management & Early Warning',procurement:'Pengadaan',  asset:'Asset Management & CMMS',audit:'Finding',license:'Lisensi, SOP & Personil',units:'Unit Management',users:'User Management',settings:'Settings & Backup'};
const TOPBAR_CFG={
  dashboard:{show:false},integrated:{label:'Reset Form',icon:'fa-rotate-left',action:()=>renderIntegrated()},
  kpi:{label:'Ke Program Kerja',icon:'fa-arrow-right',primary:false,action:()=>showView('program')},
  program:{show:false},
  risk:{show:false},
  procurement:{label:'Tambah PO',icon:'fa-plus',action:()=>openProcurementForm()},
  asset:{label:'Tambah Asset',icon:'fa-plus',action:()=>openAssetForm()},
  audit:{label:'Tambah Finding',icon:'fa-plus',action:()=>openAuditForm()},
  license:{label:'Tambah Lisensi',icon:'fa-plus',action:()=>openLicenseForm()},
  units:{label:'Tambah Unit',icon:'fa-plus',action:()=>openAddModal()},
  users:{label:'Tambah User',icon:'fa-plus',action:()=>openUserForm()},
  settings:{show:false},
};

function showView(name){
  // Auth guard
  if(!currentUser){ return; }
  const mod = VIEW_MODULE_MAP[name]||name;
  if(!canView(mod) && !currentUser.isAdmin){
    document.getElementById('content').innerHTML=`<div class="panel" style="text-align:center;padding:60px 20px">
      <i class="fa fa-lock" style="font-size:40px;color:var(--t3);margin-bottom:16px;display:block"></i>
      <div style="font-size:16px;font-weight:600;margin-bottom:8px">Akses Ditolak</div>
      <div style="font-size:12px;color:var(--t3)">Anda tidak memiliki izin untuk mengakses modul <strong>${mod}</strong>.</div>
    </div>`;
    return;
  }

  destroyCharts();currentView=name;
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===name));
  document.getElementById('page-title').textContent=VIEW_TITLES[name]||name;

  // Show/hide edit button based on permission
  const cfg=TOPBAR_CFG[name]||{};
  const btn=document.getElementById('topbar-add-btn');
  const editAllowed = canEdit(mod)||currentUser.isAdmin;
  if(cfg.show===false||!editAllowed){btn.style.display='none';}
  else{
    btn.style.display='';btn.className='btn '+(cfg.primary===false?'':'btn-primary');
    btn.onclick=cfg.action||openAddModal;
    document.getElementById('add-label').textContent=cfg.label||'Tambah';
    const ico=btn.querySelector('i');if(ico)ico.className='fa '+(cfg.icon||'fa-plus');
  }

  // Tombol ekstra Import untuk Program Kerja
  let extraBtn=document.getElementById('topbar-import-btn');
  if(name==='program'&&editAllowed){
    if(!extraBtn){
      extraBtn=document.createElement('button');
      extraBtn.id='topbar-import-btn';
      extraBtn.className='btn';
      extraBtn.style.cssText='background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:var(--success)';
      btn.parentNode.insertBefore(extraBtn,btn);
    }
    const avail=DB.procurement.filter(po=>!po.progId||!DB.programs.find(p=>p.id===po.progId)).length;
    extraBtn.innerHTML=`<i class="fa fa-file-import"></i> Import dari Pengadaan${avail>0?` <span style="background:var(--success);color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:8px">${avail}</span>`:''}`;
    extraBtn.onclick=()=>openImportPOModal();
    extraBtn.style.display='';
  } else if(extraBtn){
    extraBtn.style.display='none';
  }

  // Add view-only banner if user can only view
  const cont=document.getElementById('content');
  cont.innerHTML='';cont.className='content fade-in';void cont.offsetWidth;
  if(!editAllowed && canView(mod)){
    cont.innerHTML=`<div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:8px 14px;margin-bottom:12px;font-size:11px;color:var(--warn);display:flex;align-items:center;gap:8px">
      <i class="fa fa-eye"></i> <span>Anda hanya memiliki akses <strong>View Only</strong> pada modul ini. Hubungi Administrator untuk akses Edit.</span>
    </div>`;
  }

  autoCheckAuditOverdue();autoCheckLicenseStatus();syncKPIsFromPrograms();updateBadges();
  ({dashboard:renderDashboard,integrated:renderIntegrated,kpi:renderKPI,program:renderProgram,risk:renderRisk,procurement:renderProcurement,asset:renderAsset,audit:renderAudit,license:renderLicense,units:renderUnits,users:renderUsers,settings:renderSettings}[name]||function(){})();
}
document.querySelectorAll('.nav-item').forEach(el=>el.addEventListener('click',()=>showView(el.dataset.view)));
function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open');}

// ═══════════════ DASHBOARD ═══════════════
function renderDashboard(){
  syncKPIsFromPrograms();
  const cont=document.getElementById('content');
  const kpiAvg=DB.kpis.length?Math.round(DB.kpis.reduce((s,k)=>s+k.real,0)/DB.kpis.length):0;
  const ewsHigh=DB.ews.filter(e=>!e.acked&&(e.level==='High'||e.level==='Extreme'||e.level==='Moderate to High')).length;
  const riskHigh=DB.risks.filter(r=>riskScore(r)>=16).length;

  // Pengadaan stats
  const poTotal=DB.procurement.length;
  const poCapex=DB.procurement.filter(p=>p.jenis==='Capex');
  const poOpex=DB.procurement.filter(p=>p.jenis==='Opex');
  const poDone=DB.procurement.filter(p=>p.status==='Delivered').length;
  const poDelay=DB.procurement.filter(p=>p.delay>0).length;
  // Progress rata-rata pengadaan (berdasarkan task bobot tertimbang)
  const poProgList=DB.procurement.map(po=>{
    const rt=(po.tasks||[]).filter(t=>!t.isSection);
    const tw=rt.reduce((s,t)=>s+(t.weight||0),0);
    const dw=rt.reduce((s,t)=>s+(t.done?(t.weight||0):0),0);
    return tw>0?Math.round(dw/tw*100):0;
  });
  const poAvgProg=poProgList.length?Math.round(poProgList.reduce((a,b)=>a+b,0)/poProgList.length):0;
  const totalCapex=poCapex.reduce((s,p)=>s+p.value,0);
  const totalOpex=poOpex.reduce((s,p)=>s+p.value,0);

  cont.innerHTML=`
  <!-- STAT ROW UTAMA -->
  <div class="stat-row">
    <div class="stat-box"><div class="sl">Rata-rata KPI</div><div class="sv" style="color:${progColor(kpiAvg)}">${kpiAvg}<span style="font-size:14px">%</span></div><div class="sv-sub">${DB.kpis.length} indikator</div></div>
    <div class="stat-box"><div class="sl">Program On Track</div><div class="sv" style="color:var(--success)">${DB.programs.filter(p=>p.status==='On Track').length}<span style="font-size:14px">/${DB.programs.length}</span></div></div>
    <div class="stat-box"><div class="sl">EWS Aktif</div><div class="sv" style="color:var(--warn)">${DB.ews.filter(e=>!e.acked).length}</div><div class="sv-sub">${ewsHigh} high/extreme</div></div>
    <div class="stat-box"><div class="sl">High Risk</div><div class="sv" style="color:var(--danger)">${riskHigh}</div><div class="sv-sub">${DB.risks.length} total</div></div>
    <div class="stat-box"><div class="sl">Audit Open</div><div class="sv" style="color:var(--warn)">${DB.audit.filter(a=>a.status==='Open'||a.status==='Overdue').length}</div><div class="sv-sub">${DB.audit.filter(a=>a.status==='Overdue').length} overdue</div></div>
    <div class="stat-box"><div class="sl">Lisensi Expire</div><div class="sv" style="color:var(--danger)">${DB.licenses.filter(l=>l.status!=='Valid').length}</div><div class="sv-sub">Perlu perhatian</div></div>
  </div>

  <!-- STAT ROW PENGADAAN -->
  <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:12px">
    <div style="font-size:10px;font-weight:700;color:var(--t3);letter-spacing:.5px;margin-bottom:10px"><i class="fa fa-cart-shopping" style="color:var(--accent)"></i> PENGADAAN</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:stretch">
      <!-- Progress rata-rata -->
      <div style="flex:1;min-width:160px;background:var(--bg3);border-radius:8px;padding:10px 12px;border-left:3px solid ${progColor(poAvgProg)}">
        <div style="font-size:10px;color:var(--t3);margin-bottom:4px">Progress Rata-rata</div>
        <div style="font-size:22px;font-weight:800;color:${progColor(poAvgProg)};line-height:1">${poAvgProg}%</div>
        <div class="prog-bar-wrap" style="height:4px;margin-top:6px"><div class="prog-bar" style="width:${poAvgProg}%;background:${progColor(poAvgProg)}"></div></div>
        <div style="font-size:10px;color:var(--t3);margin-top:4px">${poDone}/${poTotal} selesai &nbsp;·&nbsp; ${poDelay} delay</div>
      </div>
      <!-- Capex -->
      <div style="flex:1;min-width:130px;background:var(--bg3);border-radius:8px;padding:10px 12px;border-left:3px solid var(--accent)">
        <div style="font-size:10px;color:var(--t3);margin-bottom:4px">CAPEX</div>
        <div style="font-size:22px;font-weight:800;color:var(--accent);line-height:1">${poCapex.length} <span style="font-size:11px;font-weight:400">PO</span></div>
        <div style="font-size:11px;color:var(--t2);margin-top:4px;font-weight:600">Rp ${totalCapex.toFixed(0)}Jt</div>
        <div class="prog-bar-wrap" style="height:4px;margin-top:6px"><div class="prog-bar" style="width:${poTotal?Math.round(poCapex.length/poTotal*100):0}%;background:var(--accent)"></div></div>
        <div style="font-size:10px;color:var(--t3);margin-top:3px">${poTotal?Math.round(poCapex.length/poTotal*100):0}% dari total PO</div>
      </div>
      <!-- Opex -->
      <div style="flex:1;min-width:130px;background:var(--bg3);border-radius:8px;padding:10px 12px;border-left:3px solid var(--purple)">
        <div style="font-size:10px;color:var(--t3);margin-bottom:4px">OPEX</div>
        <div style="font-size:22px;font-weight:800;color:var(--purple);line-height:1">${poOpex.length} <span style="font-size:11px;font-weight:400">PO</span></div>
        <div style="font-size:11px;color:var(--t2);margin-top:4px;font-weight:600">Rp ${totalOpex.toFixed(0)}Jt</div>
        <div class="prog-bar-wrap" style="height:4px;margin-top:6px"><div class="prog-bar" style="width:${poTotal?Math.round(poOpex.length/poTotal*100):0}%;background:var(--purple)"></div></div>
        <div style="font-size:10px;color:var(--t3);margin-top:3px">${poTotal?Math.round(poOpex.length/poTotal*100):0}% dari total PO</div>
      </div>
      <!-- Status breakdown -->
      <div style="flex:2;min-width:200px;background:var(--bg3);border-radius:8px;padding:10px 12px">
        <div style="font-size:10px;color:var(--t3);margin-bottom:8px">Status PO</div>
        ${[
          {label:'Delivered',color:'var(--success)'},
          {label:'In Progress',color:'var(--warn)'},
          {label:'In Transit',color:'var(--accent)'},
          {label:'Delay',color:'var(--danger)',fn:p=>p.delay>0},
          {label:'Cancelled',color:'var(--t3)'},
        ].map(({label,color,fn})=>{
          const cnt=fn?DB.procurement.filter(fn).length:DB.procurement.filter(p=>p.status===label).length;
          const pct=poTotal?Math.round(cnt/poTotal*100):0;
          return cnt>0?`<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
            <span style="font-size:10px;color:${color};min-width:70px">${label}</span>
            <div class="prog-bar-wrap" style="height:6px;flex:1"><div class="prog-bar" style="width:${pct}%;background:${color}"></div></div>
            <span style="font-size:10px;color:${color};font-weight:700;min-width:28px">${cnt}</span>
            <span style="font-size:9px;color:var(--t3)">${pct}%</span>
          </div>`:'';
        }).join('')}
        ${poTotal===0?'<div style="color:var(--t3);font-size:11px">Belum ada PO</div>':''}
      </div>
    </div>
  </div>

  <div class="grid-2">
    <div class="panel">
      <div class="panel-hd"><div class="panel-title"><i class="fa fa-bullseye" style="color:var(--accent)"></i> KPI Overview</div></div>
      <canvas id="kpiChart" height="160"></canvas>
    </div>
    <div class="panel">
      <div class="panel-hd"><div class="panel-title"><i class="fa fa-triangle-exclamation" style="color:var(--warn)"></i> EWS Live Feed</div></div>
      ${DB.ews.filter(e=>!e.acked).slice(0,4).map(e=>`
        <div class="ews-item ${e.level.toLowerCase().replace(/ /g,'-')}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span class="badge badge-${e.level==='High'||e.level==='Extreme'?'red':e.level==='Moderate to High'||e.level==='Moderate'?'yellow':'blue'}">${e.level}</span>
            <span style="font-size:10px;color:var(--t3)">${e.time}</span>
          </div>
          <div style="font-size:11px">${e.desc}</div>
          <div style="font-size:10px;color:var(--t3);margin-top:4px"><i class="fa fa-user"></i> ${e.assigned}</div>
        </div>`).join('')||'<div style="text-align:center;color:var(--t3);padding:20px">Tidak ada alert aktif</div>'}
    </div>
  </div>
  <div class="grid-2" style="margin-top:0">
    <div class="panel">
      <div class="panel-hd"><div class="panel-title"><i class="fa fa-list-check" style="color:var(--success)"></i> Status Program Kerja</div></div>
      ${DB.programs.length?DB.programs.map(p=>`
        <div style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:11px;font-weight:500">${p.name}</span>
            <span style="font-size:11px;font-weight:600;color:${progColor(p.progress)}">${p.progress}%</span>
          </div>
          <div class="prog-bar-wrap"><div class="prog-bar" style="width:${p.progress}%;background:${progColor(p.progress)}"></div></div>
          <div style="font-size:10px;color:var(--t3);margin-top:2px">${unitName(p.unitId)} · ${(p.tasks||[]).filter(t=>t.done&&!t.isSection).length}/${(p.tasks||[]).filter(t=>!t.isSection).length} tasks · ${fmtDate(p.end)}</div>
        </div>`).join(''):'<div style="text-align:center;color:var(--t3);padding:20px">Belum ada program</div>'}
    </div>
    <div class="panel">
      <div class="panel-hd"><div class="panel-title"><i class="fa fa-shield-halved" style="color:var(--purple)"></i> Risk Register Summary</div></div>
      ${DB.risks.length?[...DB.risks].sort((a,b)=>riskScore(b)-riskScore(a)).slice(0,6).map(r=>{const s=riskScore(r);const color=riskColorAPA(s);return `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:11px;flex:1">${r.desc.length>45?r.desc.substring(0,45)+'…':r.desc}</div>
        <span style="background:${color};color:${s>=12&&s<16?'#333':'#fff'};padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;margin-left:8px">${riskLevelAPA(s)}</span>
      </div>`;}).join(''):'<div style="text-align:center;color:var(--t3);padding:20px">Belum ada risiko</div>'}
    </div>
  </div>`;
  setTimeout(()=>{
    const kc=document.getElementById('kpiChart');
    if(kc&&DB.kpis.length){const ch=new Chart(kc,{type:'bar',data:{labels:DB.kpis.map(k=>k.name.length>15?k.name.substring(0,15)+'…':k.name),datasets:[{label:'Target',data:DB.kpis.map(k=>k.target),backgroundColor:'rgba(26,140,255,.2)',borderColor:'rgba(26,140,255,.5)',borderWidth:1},{label:'Realisasi',data:DB.kpis.map(k=>k.real),backgroundColor:DB.kpis.map(k=>k.real>=k.target?'rgba(34,197,94,.5)':'rgba(245,158,11,.5)'),borderColor:DB.kpis.map(k=>k.real>=k.target?'rgba(34,197,94,.8)':'rgba(245,158,11,.8)'),borderWidth:1}]},options:{responsive:true,plugins:{legend:{labels:{color:'#b1bac4',font:{size:10}}}},scales:{x:{ticks:{color:'#6e7681',font:{size:9}},grid:{color:'rgba(255,255,255,.05)'}},y:{ticks:{color:'#6e7681'},grid:{color:'rgba(255,255,255,.05)'},min:0,max:100}}}});activeCharts.push(ch);}
  },100);
}

// ═══════════════ INPUT TERINTEGRASI ═══════════════
let itTasks=[];
function renderIntegrated(){
  itTasks=[];
  const cont=document.getElementById('content');
  cont.innerHTML=`
  <div class="panel" style="border:1px solid rgba(26,140,255,.3)">
    <div class="panel-hd">
      <div><div class="panel-title"><i class="fa fa-layer-group" style="color:var(--accent)"></i> Input Terintegrasi</div>
      <div class="panel-sub">Satu form — data otomatis terdistribusi ke KPI, Program Kerja, EWS, Risk</div></div>
    </div>
    <div class="tabs">
      <button class="tab active" onclick="switchITab('program',this)">Program & KPI</button>
      <button class="tab" onclick="switchITab('risk',this)">Risk & EWS</button>
    </div>
    <div id="itab-program">
      <div class="sec-div">Informasi Program Kerja</div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Nama Program</label><input class="form-input" id="it-name" placeholder="e.g. Revamping Sistem Pendingin"></div>
        <div class="form-group"><label class="form-label">Unit</label><select class="form-select" id="it-unit">${DB.units.map(u=>`<option value="${u.id}">${u.name}</option>`).join('')}</select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">PIC</label><input class="form-input" id="it-pic" placeholder="Nama PIC"></div>
        <div class="form-group"><label class="form-label">Status</label><select class="form-select" id="it-status"><option>On Track</option><option>At Risk</option><option>Overdue</option></select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Start Date</label><input class="form-input" type="date" id="it-start"></div>
        <div class="form-group"><label class="form-label">Deadline</label><input class="form-input" type="date" id="it-end"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Budget (Rp Juta)</label><input class="form-input" type="number" id="it-budget" placeholder="0"></div>
        <div class="form-group"><label class="form-label">Terpakai (Rp Juta)</label><input class="form-input" type="number" id="it-spent" placeholder="0"></div>
      </div>
      <div class="form-group"><label class="form-label">Deskripsi</label><textarea class="form-textarea" id="it-desc" placeholder="Deskripsi program..." rows="2"></textarea></div>
      <div class="sec-div">To Do List Program</div>
      <div id="it-tasklist"></div>
      <div class="task-add">
        <input id="it-newtask" placeholder="Tambah task baru..." onkeypress="if(event.key==='Enter')addItTask()">
        <button class="btn btn-sm btn-primary" onclick="addItTask()"><i class="fa fa-plus"></i> Tambah</button>
      </div>
      <div class="sec-div" style="margin-top:16px">Pengaturan KPI</div>
      <div style="background:rgba(26,140,255,.06);border:1px solid rgba(26,140,255,.2);border-radius:8px;padding:12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <input type="checkbox" id="it-usekpi" style="width:15px;height:15px;accent-color:var(--accent)">
          <label for="it-usekpi" style="font-size:11px;cursor:pointer">Jadikan program ini sebagai KPI</label>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">KPI Target (%)</label><input class="form-input" id="it-kpitarget" type="number" value="100"></div>
          <div class="form-group"><label class="form-label">Bobot KPI (%)</label><input class="form-input" id="it-kpiweight" type="number" value="10"></div>
        </div>
      </div>
      <button class="btn btn-primary" onclick="saveIntegrated()" style="width:100%;justify-content:center;margin-top:16px"><i class="fa fa-save"></i> Simpan Program & Sinkronisasi KPI</button>
    </div>
    <div id="itab-risk" style="display:none">
      <div class="sec-div">Informasi Risiko</div>

      <!-- Unit & Nama Risiko -->
      <div class="form-row">
        <div class="form-group"><label class="form-label">Unit</label>
          <select class="form-select" id="ir-unit">${DB.units.map(u=>`<option value="${u.id}">${u.name}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Kategori Risiko</label>
          <select class="form-select" id="ir-cat">
            <option>Risiko Operasional</option>
            <option>Risiko Keuangan</option>
            <option>Risiko Strategis</option>
            <option>Risiko Keamanan</option>
            <option>Risiko Keselamatan</option>
            <option>Risiko Lingkungan</option>
          </select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Nama Risiko</label>
          <input class="form-input" id="ir-name" placeholder="Nama singkat risiko..."></div>
        <div class="form-group"><label class="form-label">PIC</label>
          <input class="form-input" id="ir-pic" placeholder="Nama PIC"></div>
      </div>
      <div class="form-group"><label class="form-label">Deskripsi Risiko</label>
        <textarea class="form-textarea" id="ir-desc" placeholder="Uraikan risiko secara detail..." rows="2"></textarea></div>

      <!-- Probabilitas & Dampak -->
      <div class="form-row">
        <div class="form-group"><label class="form-label">Tingkat Kemungkinan (Probability)</label>
          <select class="form-select" id="ir-like" onchange="updateIRScore()">
            <option value="1">A – Sangat Jarang / Very Rarely Occurs</option>
            <option value="2">B – Jarang Terjadi / Rarely Occurs</option>
            <option value="3" selected>C – Bisa Terjadi / May Occur</option>
            <option value="4">D – Sangat Mungkin / Very Likely</option>
            <option value="5">E – Hampir Pasti / Almost Certain</option>
          </select></div>
        <div class="form-group"><label class="form-label">Tingkat Dampak (Impact)</label>
          <select class="form-select" id="ir-impact" onchange="updateIRScore()">
            <option value="1">1 – Sangat Rendah / Very Low</option>
            <option value="2">2 – Rendah / Low</option>
            <option value="3" selected>3 – Moderat / Moderate</option>
            <option value="4">4 – Tinggi / High</option>
            <option value="5">5 – Sangat Tinggi / Very High</option>
          </select></div>
      </div>

      <!-- Live Score Preview -->
      <div id="ir-score-box" style="background:var(--bg3);border-radius:8px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:14px;border-left:4px solid #7cb342">
        <div style="text-align:center">
          <div style="font-size:9px;color:var(--t3);margin-bottom:2px">RISK SCORE</div>
          <div id="ir-score-val" style="font-size:28px;font-weight:900;color:#7cb342;line-height:1">9</div>
        </div>
        <div>
          <div id="ir-level-val" style="font-size:13px;font-weight:700;color:#7cb342">Low to Moderate</div>
          <div style="font-size:10px;color:var(--t3)">C (Kemungkinan) × 3 (Dampak)</div>
        </div>
      </div>

      <div class="form-group"><label class="form-label">Due Date</label>
        <input class="form-input" type="date" id="ir-due"></div>

      <!-- PENYEBAB — bisa ditambah banyak -->
      <div class="sec-div" style="margin-top:4px">Penyebab Risiko <span style="font-size:9px;color:var(--t3);font-weight:400;text-transform:none">(bisa lebih dari satu)</span></div>
      <div id="ir-causes-list" style="margin-bottom:6px"></div>
      <div style="display:flex;gap:6px;margin-bottom:12px">
        <input class="form-input" id="ir-cause-new" placeholder="Tambah penyebab risiko..." onkeypress="if(event.key==='Enter'){addIRCause();event.preventDefault()}">
        <button class="btn btn-sm btn-primary" onclick="addIRCause()" style="flex-shrink:0"><i class="fa fa-plus"></i> Tambah</button>
      </div>

      <!-- MITIGASI — bisa ditambah banyak + checklist progress -->
      <div class="sec-div">Rencana Mitigasi <span style="font-size:9px;color:var(--t3);font-weight:400;text-transform:none">(bisa lebih dari satu, centang = sudah dilakukan)</span></div>
      <div id="ir-mit-list" style="margin-bottom:6px"></div>
      <div style="display:flex;gap:6px;margin-bottom:12px">
        <input class="form-input" id="ir-mit-new" placeholder="Tambah rencana mitigasi..." onkeypress="if(event.key==='Enter'){addIRMit();event.preventDefault()}">
        <button class="btn btn-sm btn-primary" onclick="addIRMit()" style="flex-shrink:0"><i class="fa fa-plus"></i> Tambah</button>
      </div>

      <div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:10px;margin-bottom:12px;font-size:11px;color:var(--warn)"><i class="fa fa-triangle-exclamation"></i> Risk Score ≥ 6 → EWS otomatis dibuat · Low to Moderate (6–11) · Moderate (12–15) · Moderate to High (16–19) · High (20–25)</div>
      <button class="btn btn-primary" onclick="saveRiskIntegrated()" style="width:100%;justify-content:center"><i class="fa fa-save"></i> Simpan Risiko</button>
    </div>
  </div>`;
  renderItTasks();
  initIRLists();
}

// ── Integrated Risk helpers ──
let irCauses=[], irMitigations=[];

function initIRLists(){ irCauses=[]; irMitigations=[]; renderIRCauses(); renderIRMits(); updateIRScore(); }

function updateIRScore(){
  const like=parseInt(document.getElementById('ir-like')?.value||3);
  const impact=parseInt(document.getElementById('ir-impact')?.value||3);
  const s=(APA_SCORE_TABLE[like]||{})[impact]||like*impact;
  const lv=riskLevelAPA(s);
  const color=riskColorAPA(s);
  const box=document.getElementById('ir-score-box');
  const sv=document.getElementById('ir-score-val');
  const lv_el=document.getElementById('ir-level-val');
  if(box) box.style.borderLeftColor=color;
  if(sv){sv.textContent=s;sv.style.color=color;}
  if(lv_el){lv_el.textContent=lv;lv_el.style.color=color;}
}

function addIRCause(){
  const inp=document.getElementById('ir-cause-new');
  if(!inp||!inp.value.trim()) return;
  irCauses.push({id:uid(),text:inp.value.trim()});
  inp.value=''; renderIRCauses();
}
function removeIRCause(id){ irCauses=irCauses.filter(x=>x.id!==id); renderIRCauses(); }
function renderIRCauses(){
  const el=document.getElementById('ir-causes-list'); if(!el) return;
  el.innerHTML=irCauses.length
    ? irCauses.map(c=>`<div class="task-item">
        <i class="fa fa-circle-dot" style="color:var(--warn);font-size:10px;flex-shrink:0"></i>
        <span class="task-text">${c.text}</span>
        <button class="btn btn-sm" style="padding:1px 5px;opacity:.5" onclick="removeIRCause('${c.id}')"><i class="fa fa-xmark"></i></button>
      </div>`).join('')
    : '<div style="font-size:11px;color:var(--t3);padding:4px 8px">Belum ada penyebab. Tambahkan di bawah.</div>';
}

function addIRMit(){
  const inp=document.getElementById('ir-mit-new');
  if(!inp||!inp.value.trim()) return;
  irMitigations.push({id:uid(),text:inp.value.trim(),done:false});
  inp.value=''; renderIRMits();
}
function removeIRMit(id){ irMitigations=irMitigations.filter(x=>x.id!==id); renderIRMits(); }
function toggleIRMit(id){
  const m=irMitigations.find(x=>x.id===id);
  if(m) m.done=!m.done;
  renderIRMits();
}
function renderIRMits(){
  const el=document.getElementById('ir-mit-list'); if(!el) return;
  const done=irMitigations.filter(m=>m.done).length;
  const total=irMitigations.length;
  el.innerHTML=irMitigations.length
    ? `${irMitigations.map(m=>`<div class="task-item">
        <input type="checkbox" ${m.done?'checked':''} onchange="toggleIRMit('${m.id}')" style="width:14px;height:14px;accent-color:var(--accent);flex-shrink:0">
        <span class="task-text ${m.done?'done':''}" onclick="toggleIRMit('${m.id}')">${m.text}</span>
        <button class="btn btn-sm" style="padding:1px 5px;opacity:.5" onclick="removeIRMit('${m.id}')"><i class="fa fa-xmark"></i></button>
      </div>`).join('')}
      ${total>0?`<div style="display:flex;align-items:center;gap:8px;margin-top:6px;padding:4px 8px">
        <div class="prog-bar-wrap" style="height:5px"><div class="prog-bar" style="width:${Math.round(done/total*100)}%;background:var(--success)"></div></div>
        <span style="font-size:10px;color:var(--t3)">${done}/${total} selesai</span>
      </div>`:''}` 
    : '<div style="font-size:11px;color:var(--t3);padding:4px 8px">Belum ada rencana mitigasi. Tambahkan di bawah.</div>';
}
function renderItTasks(){
  const el=document.getElementById('it-tasklist');if(!el)return;
  el.innerHTML=itTasks.length?itTasks.map((t,i)=>`<div class="task-item"><input type="checkbox" ${t.done?'checked':''} onchange="itTasks[${i}].done=this.checked"><span class="task-text ${t.done?'done':''}">${t.text}</span><button class="btn btn-sm btn-danger" onclick="itTasks.splice(${i},1);renderItTasks()" style="padding:1px 6px"><i class="fa fa-xmark"></i></button></div>`).join(''):'<div style="font-size:11px;color:var(--t3);padding:4px 8px">Belum ada task. Tambahkan di bawah.</div>';
}
function addItTask(){const inp=document.getElementById('it-newtask');if(!inp.value.trim())return;itTasks.push({id:uid(),text:inp.value.trim(),done:false});inp.value='';renderItTasks();}
function switchITab(name,btn){
  ['program','risk'].forEach(t=>{const el=document.getElementById('itab-'+t);if(el)el.style.display=t===name?'block':'none';});
  document.querySelectorAll('.tabs .tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  if(name==='risk') setTimeout(()=>{initIRLists();},50);
}
function saveIntegrated(){
  const name=document.getElementById('it-name').value.trim();if(!name){alert('Nama program wajib diisi');return;}
  const prog={id:uid(),name,unitId:document.getElementById('it-unit').value,pic:document.getElementById('it-pic').value,status:document.getElementById('it-status').value,start:document.getElementById('it-start').value,end:document.getElementById('it-end').value,budget:parseFloat(document.getElementById('it-budget').value)||0,spent:parseFloat(document.getElementById('it-spent').value)||0,desc:document.getElementById('it-desc').value,useAsKPI:document.getElementById('it-usekpi').checked,kpiTarget:parseFloat(document.getElementById('it-kpitarget').value)||100,kpiWeight:parseInt(document.getElementById('it-kpiweight').value)||10,riskId:'',tasks:[...itTasks],progress:0};
  prog.progress=recalcProgressFromTasks(prog);DB.programs.push(prog);syncKPIsFromPrograms();scheduleSave();
  alert('✅ Program berhasil disimpan dan KPI disinkronisasi!');renderIntegrated();
}
function saveRiskIntegrated(){
  const desc=document.getElementById('ir-desc').value.trim();
  const name=document.getElementById('ir-name').value.trim();
  if(!desc&&!name){alert('Nama Risiko atau Deskripsi wajib diisi');return;}
  const like=parseInt(document.getElementById('ir-like').value);
  const impact=parseInt(document.getElementById('ir-impact').value);
  const score=(APA_SCORE_TABLE[like]||{})[impact]||like*impact;
  const causesText=irCauses.map(c=>c.text).join('; ');
  const mitText=irMitigations.map(m=>(m.done?'[✓] ':'[ ] ')+m.text).join('; ');
  const r={
    id:uid(),
    name:name||desc.substring(0,40),
    cat:document.getElementById('ir-cat').value,
    desc:desc||name,
    cause:causesText||'—',
    causes:[...irCauses],
    impact,likelihood:like,
    mitigation:mitText||'—',
    mitigations:[...irMitigations],
    pic:document.getElementById('ir-pic').value,
    unitId:document.getElementById('ir-unit').value,
    due:document.getElementById('ir-due').value,
    status:'Open',progId:''
  };
  DB.risks.push(r);
  if(score>=6){
    DB.ews.push({id:uid(),desc:`[Auto-EWS] ${r.name||r.desc}`,cat:r.cat,level:riskLevelAPA(score),
      trigger:`Risk Score: ${score} (${LIKELIHOOD_LABELS[like]}×${impact}) — ${riskLevelAPA(score)}`,
      time:new Date().toLocaleTimeString('id-ID'),assigned:r.pic,acked:false,auto:true,sourceId:r.id,sourceType:'risk'});
    alert(`✅ Risiko disimpan!\nScore: ${score} → ${riskLevelAPA(score)}\nEWS otomatis dibuat.`);
  } else {
    alert(`✅ Risiko disimpan! Score: ${score} (Low)`);
  }
  scheduleSave();updateBadges();
  // Reset form
  document.getElementById('ir-desc').value='';
  document.getElementById('ir-name').value='';
  document.getElementById('ir-pic').value='';
  document.getElementById('ir-due').value='';
  irCauses=[]; irMitigations=[];
  renderIRCauses(); renderIRMits();
  updateIRScore();
}
// (EWS input terintegrasi dihapus - input melalui menu Risk & EWS)

// ═══════════════ KPI ═══════════════
function renderKPI(){
  syncKPIsFromPrograms();const cont=document.getElementById('content');
  const avg=DB.kpis.length?Math.round(DB.kpis.reduce((s,k)=>s+k.real,0)/DB.kpis.length):0;
  const totalW=DB.kpis.reduce((s,k)=>s+k.weight,0);
  cont.innerHTML=`
  <div style="background:rgba(26,140,255,.06);border:1px solid rgba(26,140,255,.2);border-radius:10px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
    <i class="fa fa-circle-info" style="color:var(--accent)"></i>
    <span style="font-size:11px;color:var(--t2)">KPI diambil otomatis dari Program Kerja yang ditandai sebagai KPI. Realisasi = % task selesai program.</span>
    <button class="btn btn-sm" onclick="showView('program')" style="margin-left:auto"><i class="fa fa-arrow-right"></i> Ke Program Kerja</button>
  </div>
  <div class="stat-row">
    <div class="stat-box"><div class="sl">Total KPI</div><div class="sv">${DB.kpis.length}</div></div>
    <div class="stat-box"><div class="sl">Rata-rata Realisasi</div><div class="sv" style="color:${progColor(avg)}">${avg}%</div></div>
    <div class="stat-box"><div class="sl">Total Bobot</div><div class="sv" style="color:${totalW>100?'var(--danger)':totalW===100?'var(--success)':'var(--warn)'}">${totalW}%</div></div>
    <div class="stat-box"><div class="sl">Tercapai</div><div class="sv" style="color:var(--success)">${DB.kpis.filter(k=>k.real>=k.target).length}</div></div>
  </div>
  <div class="panel">
    <div class="panel-hd"><div class="panel-title">Tabel KPI</div></div>
    <table class="tbl">
      <thead><tr><th>KPI / Program</th><th>Unit</th><th>PIC</th><th>Target</th><th>Realisasi</th><th>Bobot</th><th>Progress</th><th>Status</th></tr></thead>
      <tbody>${DB.kpis.map(k=>{const sc=k.real>=k.target?'badge-green':k.real>=k.target*.7?'badge-yellow':'badge-red';return `<tr>
        <td><div style="font-weight:500">${k.name}</div><div style="font-size:10px;color:var(--t3)"><i class="fa fa-link" style="font-size:9px"></i> Dari Program</div></td>
        <td style="color:var(--t3)">${k.unit}</td><td style="color:var(--t3)">${k.pic}</td>
        <td style="font-weight:600">${k.target}%</td>
        <td><span style="font-weight:700;color:${progColor(k.real)}">${k.real}%</span></td>
        <td>${k.weight}%</td>
        <td style="min-width:100px"><div style="display:flex;align-items:center;gap:6px"><div class="prog-bar-wrap"><div class="prog-bar" style="width:${k.real}%;background:${progColor(k.real)}"></div></div><span style="font-size:10px;color:${progColor(k.real)}">${k.real}%</span></div></td>
        <td><span class="badge ${sc}">${k.real>=k.target?'Tercapai':k.real>=k.target*.7?'Hampir':'Belum'}</span></td>
      </tr>`;}).join('')||'<tr><td colspan="8" style="text-align:center;color:var(--t3);padding:20px">Belum ada KPI. Tandai program sebagai KPI di menu Program Kerja.</td></tr>'}</tbody>
    </table>
  </div>`;}

function quickEditSpent(id){
  const p=DB.programs.find(x=>x.id===id);if(!p)return;
  const val=prompt(`Anggaran Terpakai untuk "${p.name}" (Rp Juta):\nAnggaran total: Rp ${p.budget}Jt`,p.spent||0);
  if(val===null)return;
  const newSpent=parseFloat(val)||0;
  if(newSpent<0){alert('Tidak boleh negatif');return;}
  if(newSpent>p.budget*2&&!confirm(`Nilai terpakai (Rp ${newSpent}Jt) melebihi anggaran (Rp ${p.budget}Jt). Lanjutkan?`))return;
  p.spent=newSpent;
  // Sinkron ke PO jika ada
  if(p.fromPO){
    const po=DB.procurement.find(x=>x.id===p.fromPO);
    if(po){po.spent=newSpent;po.budget=po.budget||p.budget;}
  }
  scheduleSave();renderProgram();
}
function showToast(msg, color='var(--success)'){
  const el=document.getElementById('save-indicator'); if(!el) return;
  el.innerHTML=`<i class="fa fa-rotate" style="color:${color}"></i> ${msg}`;
  el.style.color=color; el.style.opacity='1';
  clearTimeout(el._t); el._t=setTimeout(()=>{el.style.opacity='0';},3000);
}

// ════ MOVE ITEM UP/DOWN ════
function moveItem(col, id, dir){
  const arr = col==='programs'?DB.programs:col==='procurement'?DB.procurement:col==='risks'?DB.risks:null;
  if(!arr) return;
  const idx = arr.findIndex(x=>x.id===id);
  if(idx<0) return;
  const newIdx = idx + dir;
  if(newIdx<0||newIdx>=arr.length) return;
  const tmp=arr[idx]; arr[idx]=arr[newIdx]; arr[newIdx]=tmp;
  scheduleSave();
  if(col==='programs') renderProgram();
  else if(col==='procurement') renderProcurement();
  else if(col==='risks') renderRisk();
}

// ════ TOGGLE COLLAPSE ════
if(!window._progOpen) window._progOpen={};
if(!window._poOpen)   window._poOpen={};

function toggleProgCard(id){
  if(!window._progOpen) window._progOpen={};
  window._progOpen[id] = !window._progOpen[id];
  const detail = document.getElementById('progdetail-'+id);
  const card   = detail?.closest('div[onclick]')||detail?.parentElement;
  if(detail) detail.style.display = window._progOpen[id]?'block':'none';
  // Update chevron icon
  const icon = document.querySelector(`[onclick*="toggleProgCard('${id}')"] .fa-chevron-right, [onclick*="toggleProgCard('${id}')"] .fa-chevron-down`);
  if(icon){ icon.className = window._progOpen[id]?'fa fa-chevron-down':'fa fa-chevron-right'; }
}

function togglePoCard(id){
  if(!window._poOpen) window._poOpen={};
  window._poOpen[id] = !window._poOpen[id];
  const detail = document.getElementById('podetail-'+id);
  if(detail) detail.style.display = window._poOpen[id]?'block':'none';
  const icon = document.querySelector(`[onclick*="togglePoCard('${id}')"] .fa-chevron-right, [onclick*="togglePoCard('${id}')"] .fa-chevron-down`);
  if(icon){ icon.className = window._poOpen[id]?'fa fa-chevron-down':'fa fa-chevron-right'; }
}

function renderProgram(){
  const cont=document.getElementById('content');
  const {bar,filtered,groups,showHeader}=buildFilterBar('Program',DB.programs,p=>p.start||'',p=>p.unitId||'');
  function progCard(p){
    const dl=daysLeft(p.end);
    const dlC=dl===null?'var(--t3)':dl<0?'var(--danger)':dl<=7?'var(--warn)':'var(--t3)';
    const prog=recalcProgressFromTasks(p);
    const isOpen=window._progOpen&&window._progOpen[p.id];
    return `<div style="background:var(--bg3);border-radius:8px;margin-bottom:8px;border:1px solid var(--border);overflow:hidden">
      <!-- ── HEADER (selalu tampil, klik untuk buka/tutup) ── -->
      <div onclick="toggleProgCard('${p.id}')" style="display:flex;align-items:center;gap:10px;padding:11px 14px;cursor:pointer;user-select:none"
        onmouseover="this.style.background='rgba(255,255,255,.03)'" onmouseout="this.style.background=''">
        <!-- Toggle icon -->
        <i class="fa fa-chevron-${isOpen?'down':'right'}" style="font-size:10px;color:var(--t3);flex-shrink:0;transition:.2s"></i>
        <!-- Status dot -->
        <div style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${p.status==='On Track'||p.status==='Completed'?'var(--success)':p.status==='At Risk'?'var(--warn)':'var(--danger)'}"></div>
        <!-- Nama program -->
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
          <div style="font-size:10px;color:var(--t3);margin-top:1px">
            <i class="fa fa-building"></i> ${unitName(p.unitId)} &nbsp;·&nbsp;
            <i class="fa fa-user"></i> ${p.pic} &nbsp;·&nbsp;
            ${fmtDate(p.end)}
            ${dl<0?`&nbsp;·&nbsp;<span style="color:var(--danger);font-weight:600"><i class="fa fa-circle-exclamation"></i> OVERDUE</span>`:dl===0?'&nbsp;·&nbsp;<span style="color:var(--warn)">⚠ Hari ini</span>':dl<=7?`&nbsp;·&nbsp;<span style="color:var(--warn)">Sisa ${dl}h</span>`:''}
          </div>
        </div>
        <!-- Progress bar + persen -->
        <div style="flex-shrink:0;display:flex;align-items:center;gap:8px;min-width:140px">
          <div style="flex:1">
            <div class="prog-bar-wrap" style="height:6px"><div class="prog-bar" style="width:${prog}%;background:${progColor(prog)}"></div></div>
          </div>
          <span style="font-size:12px;font-weight:700;color:${progColor(prog)};min-width:36px;text-align:right">${prog}%</span>
        </div>
        <!-- Badges -->
        <div style="display:flex;gap:4px;flex-shrink:0">
          ${p.useAsKPI?'<span class="badge badge-blue" style="font-size:9px"><i class="fa fa-bullseye"></i> KPI</span>':''}
          ${p.fromPO?'<span class="badge badge-teal" style="font-size:9px"><i class="fa fa-arrow-right-arrow-left"></i> Sync</span>':''}
          <span class="badge ${p.status==='On Track'?'badge-green':p.status==='At Risk'?'badge-yellow':'badge-red'}" style="font-size:9px">${p.status}</span>
        </div>
      </div>

      <!-- ── DETAIL (tersembunyi, tampil saat diklik) ── -->
      <div id="progdetail-${p.id}" style="display:${isOpen?'block':'none'};padding:0 14px 14px;border-top:1px solid var(--border)">
        <div style="display:flex;gap:16px;margin:10px 0;font-size:10px;color:var(--t3);flex-wrap:wrap;align-items:center">
          <span><i class="fa fa-calendar"></i> ${fmtDate(p.start)} – ${fmtDate(p.end)}</span>
          <span><i class="fa fa-wallet"></i> Anggaran: <strong style="color:var(--t2)">Rp ${p.budget}Jt</strong></span>
          <span>Terpakai: <strong style="color:${(p.spent||0)/(p.budget||1)>.9?'var(--danger)':(p.spent||0)/(p.budget||1)>.7?'var(--warn)':'var(--success)'}">Rp ${p.spent||0}Jt (${Math.round((p.spent||0)/((p.budget||1))*100)}%)</strong></span>
          <button class="btn btn-sm" style="padding:1px 7px;font-size:9px" onclick="quickEditSpent('${p.id}');event.stopPropagation()" title="Edit anggaran terpakai"><i class="fa fa-pen"></i> Edit Terpakai</button>
        </div>
        <div id="taskblock-${p.id}">${buildTasksHTML(p.tasks,p.id,'programs')}</div>
        <div style="display:flex;gap:6px;margin-top:10px;align-items:center">
          <button class="btn btn-sm" onclick="editProgram('${p.id}');event.stopPropagation()"><i class="fa fa-pen"></i> Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteProgram('${p.id}');event.stopPropagation()"><i class="fa fa-trash"></i></button>
          <div style="margin-left:auto;display:flex;gap:3px">
            <button class="btn btn-sm" onclick="moveItem('programs','${p.id}',-1);event.stopPropagation()" title="Pindah ke atas" style="padding:3px 8px"><i class="fa fa-chevron-up"></i></button>
            <button class="btn btn-sm" onclick="moveItem('programs','${p.id}',1);event.stopPropagation()" title="Pindah ke bawah" style="padding:3px 8px"><i class="fa fa-chevron-down"></i></button>
          </div>
        </div>
      </div>
    </div>`;
  }
  cont.innerHTML=`
  <div class="stat-row">
    <div class="stat-box"><div class="sl">Total Program</div><div class="sv">${filtered.length}</div></div>
    <div class="stat-box"><div class="sl">On Track</div><div class="sv" style="color:var(--success)">${filtered.filter(p=>p.status==='On Track').length}</div></div>
    <div class="stat-box"><div class="sl">At Risk</div><div class="sv" style="color:var(--warn)">${filtered.filter(p=>p.status==='At Risk').length}</div></div>
    <div class="stat-box"><div class="sl">Overdue</div><div class="sv" style="color:var(--danger)">${filtered.filter(p=>isOverdue(p.end)).length}</div></div>
  </div>
  ${bar}
  ${filtered.length===0?'<div class="panel" style="text-align:center;color:var(--t3);padding:40px">Tidak ada program sesuai filter.</div>':
    Object.entries(groups).map(([gn,items])=>`
      ${showHeader?renderGroupHeader(gn,items.length):''}
      <div class="panel">
        ${!showHeader?`<div class="panel-hd"><div style="display:flex;align-items:center;gap:8px"><div style="width:10px;height:10px;border-radius:50%;background:${unitColor(items[0]?.unitId||'')}"></div><div class="panel-title">${unitName(items[0]?.unitId||'')}</div><span class="badge badge-blue">${items.length} program</span></div></div>`:''}
        ${items.map(progCard).join('')}
      </div>`).join('')}`;
}
function buildTasksHTML(tasks,id,col){
  if(!tasks||!tasks.length) return `<div style="font-size:10px;color:var(--t3);padding:4px 8px">Belum ada task</div>
  <div style="display:flex;gap:6px;margin-top:4px">
    <input id="newtask-${id}" class="form-input" style="flex:1;font-size:11px;padding:5px 8px" placeholder="Tambah task baru..." onkeypress="if(event.key==='Enter')addTask('${col}','${id}')">
    <button class="btn btn-sm btn-primary" onclick="addTask('${col}','${id}')"><i class="fa fa-plus"></i></button>
  </div>`;

  // Only count non-section tasks for weight/progress
  const realTasks = tasks.filter(t=>!t.isSection);
  ensureWeights(realTasks);
  realTasks.forEach(rt=>{ const t=tasks.find(x=>x.id===rt.id); if(t) t.weight=rt.weight; });
  const totalW = realTasks.reduce((s,t)=>s+(t.weight||0),0);
  const doneW  = realTasks.reduce((s,t)=>s+(t.done?(t.weight||0):0),0);
  const progPct = totalW>0?Math.round(doneW/totalW*100):0;

  return `<div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <span style="font-size:10px;font-weight:600;color:var(--t3)">TO DO LIST</span>
      <span style="font-size:10px;color:${progColor(progPct)};font-weight:600">${progPct}% (bobot tertimbang)</span>
    </div>
    <div class="prog-bar-wrap" style="height:6px;margin-bottom:8px"><div class="prog-bar" style="width:${progPct}%;background:${progColor(progPct)}"></div></div>
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr>
        <th style="padding:4px 6px;font-size:9px;font-weight:700;color:var(--t3);text-align:left;border-bottom:1px solid var(--border)">Task</th>
        <th style="padding:4px 6px;font-size:9px;font-weight:700;color:var(--t3);text-align:center;border-bottom:1px solid var(--border);white-space:nowrap">Bobot (%)</th>
        ${col==='procurement'?`<th style="padding:4px 6px;font-size:9px;font-weight:700;color:var(--t3);text-align:center;border-bottom:1px solid var(--border);white-space:nowrap">Target Selesai</th>`:''}
        <th style="padding:4px 6px;font-size:9px;font-weight:700;color:var(--t3);text-align:center;border-bottom:1px solid var(--border);white-space:nowrap">Total: <span style="color:${Math.abs(totalW-100)<=1?'var(--success)':'var(--danger)'}">${totalW}%</span></th>
        <th style="padding:4px 2px;border-bottom:1px solid var(--border)"></th>
      </tr></thead>
      <tbody>
        ${tasks.map(t=>{
          const indent=(t.indent||0)*14;
          if(t.isSection){
            const sc=t.text.startsWith('PLANNING')?'var(--accent)':t.text.startsWith('IMPL')||t.text.startsWith('Proses')?'var(--purple)':t.text.startsWith('IMPACT')||t.text.startsWith('Result')?'var(--success)':'var(--warn)';
            return `<tr style="background:rgba(255,255,255,.03)">
              <td colspan="${col==='procurement'?5:4}" style="padding:7px 6px 5px ${6+indent}px">
                <div style="display:flex;align-items:center;gap:8px">
                  <span style="font-size:10px;font-weight:800;color:${sc};letter-spacing:.5px;text-transform:uppercase">${t.text}</span>
                  <div style="flex:1;height:1px;background:${sc}30"></div>
                  <button class="btn btn-sm" style="padding:1px 4px;font-size:9px;opacity:.3" onclick="deleteTask('${col}','${id}','${t.id}')" title="Hapus section"><i class="fa fa-xmark"></i></button>
                </div>
              </td>
            </tr>`;
          }
          const tdl=t.due?daysLeft(t.due):null;
          return `<tr style="border-bottom:1px solid rgba(255,255,255,.03)">
            <td style="padding:5px 6px 5px ${6+indent}px">
              <div style="display:flex;align-items:center;gap:7px">
                <input type="checkbox" ${t.done?'checked':''} onchange="toggleTask('${col}','${id}','${t.id}')" style="width:14px;height:14px;accent-color:var(--accent);flex-shrink:0">
                <span class="${t.done?'task-text done':'task-text'}" onclick="toggleTask('${col}','${id}','${t.id}')">${t.text}</span>
              </div>
            </td>
            <td style="padding:5px 6px;text-align:center">
              <input type="number" value="${t.weight||0}" min="0" max="100" onchange="updateTaskWeight('${col}','${id}','${t.id}',this.value)"
                style="width:52px;background:var(--bg3);border:1px solid var(--border2);color:${t.done?'var(--success)':'var(--t1)'};padding:3px 5px;border-radius:4px;font-size:11px;font-weight:700;text-align:center">
            </td>
            ${col==='procurement'?`<td style="padding:5px 6px;text-align:center">
              <input type="date" value="${t.due||""}" onchange="updateTaskDue('${col}','${id}','${t.id}',this.value)"
                style="background:var(--bg3);border:1px solid var(--border2);color:${t.done?'var(--success)':tdl===null?'var(--t3)':tdl<0?'var(--danger)':tdl<=3?'var(--warn)':'var(--success)'};padding:3px 5px;border-radius:4px;font-size:10px;width:110px">
              ${t.done?`<div style="font-size:9px;color:var(--success)"><i class="fa fa-check"></i> Selesai</div>`:tdl!==null?`<div style="font-size:9px;color:${tdl<0?'var(--danger)':tdl<=3?'var(--warn)':'var(--t3)'}">${tdl<0?'⚠ Lewat '+Math.abs(tdl)+'h':tdl===0?'Hari ini':tdl+'h lagi'}</div>`:''}
            </td>`:''}
            <td style="padding:5px 6px;text-align:center">
              ${t.done?`<span style="font-size:10px;color:var(--success)"><i class="fa fa-check"></i> ${t.weight||0}%</span>`:`<span style="font-size:10px;color:var(--t3)">—</span>`}
            </td>
            <td style="padding:5px 4px;text-align:right">
              <button class="btn btn-sm" style="padding:1px 5px;font-size:9px;opacity:.4" onclick="deleteTask('${col}','${id}','${t.id}')"><i class="fa fa-xmark"></i></button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
      <input id="newtask-${id}" class="form-input" style="flex:1;background:var(--bg3);border:1px dashed var(--border2);color:var(--t1);padding:5px 8px;border-radius:5px;font-size:11px" placeholder="Tambah task baru..." onkeypress="if(event.key==='Enter')addTask('${col}','${id}')">
      <button class="btn btn-sm btn-primary" onclick="addTask('${col}','${id}')"><i class="fa fa-plus"></i> Tambah</button>
      <button class="btn btn-sm" onclick="autoDistributeWeights('${col}','${id}')" title="Distribusi bobot merata"><i class="fa fa-sliders"></i> Auto</button>
    </div>
  </div>`;
}
function toggleTask(col,id,tid){
  let obj=col==='programs'?DB.programs.find(x=>x.id===id):col==='procurement'?DB.procurement.find(x=>x.id===id):DB.audit.find(x=>x.id===id);
  if(!obj)return;const t=obj.tasks.find(x=>x.id===tid);if(t)t.done=!t.done;
  if(col==='programs'){
    obj.progress=recalcProgressFromTasks(obj);syncKPIsFromPrograms();
    if(obj.fromPO) syncProgramToPO(obj.id); // sinkron ke PO
  }
  if(col==='procurement'){
    if(obj.progId) syncPOToProgram(obj.id); // sinkron ke Program
  }
  if(col==='audit'){const done=obj.tasks.filter(x=>x.done).length;if(done===obj.tasks.length)obj.status='Completed';else if(obj.status==='Completed')obj.status='In Progress';}
  const block=document.getElementById('taskblock-'+id);if(block)block.innerHTML=buildTasksHTML(obj.tasks,id,col);
  scheduleSave();
}
function addTask(col,id){
  const inp=document.getElementById('newtask-'+id);
  if(!inp||!inp.value.trim()) return;
  let obj=col==='programs'?DB.programs.find(x=>x.id===id):col==='procurement'?DB.procurement.find(x=>x.id===id):DB.audit.find(x=>x.id===id);
  if(!obj) return;
  if(!obj.tasks) obj.tasks=[];
  obj.tasks.push({id:uid(),text:inp.value.trim(),done:false,weight:0});
  // Auto-redistribute weights evenly when new task added
  const w=Math.floor(100/obj.tasks.length);
  const rem=100-w*obj.tasks.length;
  obj.tasks.forEach((t,i)=>{t.weight=w+(i===0?rem:0);});
  if(col==='programs'){obj.progress=recalcProgressFromTasks(obj);syncKPIsFromPrograms();}
  inp.value='';
  const block=document.getElementById('taskblock-'+id);
  if(block) block.innerHTML=buildTasksHTML(obj.tasks,id,col);
  scheduleSave();
}
function deleteTask(col,id,tid){
  let obj=col==='programs'?DB.programs.find(x=>x.id===id):col==='procurement'?DB.procurement.find(x=>x.id===id):DB.audit.find(x=>x.id===id);
  if(!obj) return;
  obj.tasks=obj.tasks.filter(t=>t.id!==tid);
  // Redistribute weights if total no longer 100
  if(obj.tasks.length>0){
    const totalW=obj.tasks.reduce((s,t)=>s+(t.weight||0),0);
    if(Math.abs(totalW-100)>2){
      const w=Math.floor(100/obj.tasks.length);
      const rem=100-w*obj.tasks.length;
      obj.tasks.forEach((t,i)=>{t.weight=w+(i===0?rem:0);});
    }
  }
  if(col==='programs'){obj.progress=recalcProgressFromTasks(obj);syncKPIsFromPrograms();}
  const block=document.getElementById('taskblock-'+id);
  if(block) block.innerHTML=buildTasksHTML(obj.tasks,id,col);
  scheduleSave();
}

function openImportPOModal(){
  const availablePO=DB.procurement.filter(po=>!po.progId||!DB.programs.find(p=>p.id===po.progId));
  document.getElementById('modal-title').textContent='Import PO ke Program Kerja';
  document.getElementById('modal-body').innerHTML=`
    ${availablePO.length===0?`
      <div style="text-align:center;padding:40px;color:var(--t3)">
        <i class="fa fa-box-open" style="font-size:40px;margin-bottom:16px;display:block;color:var(--border2)"></i>
        <div style="font-size:14px;font-weight:600;margin-bottom:6px">Tidak ada PO yang tersedia</div>
        <div style="font-size:11px">Semua PO sudah terhubung ke Program Kerja, atau belum ada PO dibuat.</div>
        <button class="btn btn-sm" onclick="showView('procurement');closeModalDirect()" style="margin-top:14px"><i class="fa fa-cart-shopping"></i> Buka menu Pengadaan</button>
      </div>`:`
      <div style="font-size:11px;color:var(--t3);margin-bottom:12px">
        <i class="fa fa-circle-info" style="color:var(--accent)"></i>
        Pilih PO yang ingin dijadikan Program Kerja. Data tersinkronisasi otomatis dua arah.
      </div>

      <!-- Tombol pilih semua -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <label style="font-size:11px;cursor:pointer;display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="chk-all-po" onchange="document.querySelectorAll('.import-po-chk').forEach(c=>c.checked=this.checked)" style="width:14px;height:14px;accent-color:var(--accent)">
          Pilih Semua (${availablePO.length})
        </label>
        <span id="selected-count" style="font-size:10px;color:var(--accent)">0 dipilih</span>
      </div>

      <div style="max-height:380px;overflow-y:auto;padding-right:4px">
        ${availablePO.map(po=>{
          const jc=po.jenis==='Capex'?'var(--accent)':po.jenis==='Opex'?'var(--purple)':'var(--t3)';
          const u=DB.units.find(x=>x.id===po.unitId);
          const div=u?u.divisi:'—';
          const dl=daysLeft(po.due);
          return `<label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg3);border-radius:8px;margin-bottom:6px;cursor:pointer;border:1px solid var(--border);transition:.15s"
            onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
            <input type="checkbox" value="${po.id}" class="import-po-chk" onchange="updateSelectedCount()"
              style="width:16px;height:16px;accent-color:var(--accent);flex-shrink:0;margin-top:3px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
                <span style="background:${jc}20;color:${jc};border:1px solid ${jc}40;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700">${po.jenis||'—'}</span>
                <span style="font-size:12px;font-weight:600">${po.item}</span>
              </div>
              <div style="font-size:10px;color:var(--t3);line-height:1.7">
                <i class="fa fa-truck"></i> ${po.vendor||'—'} &nbsp;·&nbsp;
                <i class="fa fa-building"></i> ${u?u.name:'—'} &nbsp;·&nbsp;
                <i class="fa fa-sitemap"></i> ${div}<br>
                <i class="fa fa-wallet"></i> <strong style="color:${jc}">Rp ${po.value||0}Jt</strong> &nbsp;·&nbsp;
                <i class="fa fa-calendar"></i> Due: <span style="color:${dl<0?'var(--danger)':dl<=7?'var(--warn)':'var(--t3)'}">${po.due?new Date(po.due).toLocaleDateString('id-ID'):'—'}${dl<0?' ⚠ OVERDUE':''}</span>
              </div>
            </div>
            <span class="badge ${po.status==='Delivered'?'badge-green':po.delay>0?'badge-red':'badge-yellow'}" style="font-size:9px;flex-shrink:0;align-self:center">${po.status}</span>
          </label>`;
        }).join('')}
      </div>

      <div style="background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:8px;padding:8px 12px;font-size:11px;color:var(--success);margin:12px 0">
        <i class="fa fa-arrow-right-arrow-left"></i> PO yang diimport akan tersinkronisasi dua arah dengan Program Kerja secara otomatis.
      </div>

      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" style="flex:1" onclick="importPOToProgram()"><i class="fa fa-file-import"></i> Import yang Dipilih</button>
        <button class="btn" onclick="closeModalDirect()">Batal</button>
      </div>`}`;
  openModalDirect();
}

function updateSelectedCount(){
  const n=document.querySelectorAll('.import-po-chk:checked').length;
  const el=document.getElementById('selected-count');
  if(el) el.textContent=n+' dipilih';
}

function openProgramForm(uid2){
  document.getElementById('modal-title').textContent='Tambah Program Kerja';
  // Get PO yang belum punya Program (progId kosong)
  const availablePO = DB.procurement.filter(po=>!po.progId||!DB.programs.find(p=>p.id===po.progId));
  document.getElementById('modal-body').innerHTML=`
    <!-- Tab pilihan -->
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <button id="tab-manual" onclick="switchProgTab('manual')" class="btn btn-primary" style="flex:1;justify-content:center"><i class="fa fa-pen"></i> Input Manual</button>
      <button id="tab-import" onclick="switchProgTab('import')" class="btn" style="flex:1;justify-content:center;position:relative">
        <i class="fa fa-file-import"></i> Import dari Pengadaan
        ${availablePO.length>0?`<span style="position:absolute;top:-6px;right:-4px;background:var(--accent);color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:8px">${availablePO.length}</span>`:''}
      </button>
    </div>

    <!-- FORM MANUAL -->
    <div id="progform-manual">
      <div class="form-group"><label class="form-label">Nama Program</label><input class="form-input" id="np-name" placeholder="Nama program"></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Unit</label><select class="form-select" id="np-unit">${DB.units.map(u=>`<option value="${u.id}"${u.id===uid2?' selected':''}>${u.name}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">PIC</label><input class="form-input" id="np-pic" placeholder="Nama PIC"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Start</label><input class="form-input" type="date" id="np-start"></div>
        <div class="form-group"><label class="form-label">Deadline</label><input class="form-input" type="date" id="np-end"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Budget (Rp Juta)</label><input class="form-input" type="number" id="np-budget" placeholder="0"></div>
        <div class="form-group"><label class="form-label">Status</label><select class="form-select" id="np-status"><option>On Track</option><option>At Risk</option><option>Overdue</option></select></div>
      </div>
      <div style="background:rgba(26,140,255,.06);border:1px solid rgba(26,140,255,.2);border-radius:8px;padding:12px;margin:8px 0">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="np-kpi" style="width:14px;height:14px;accent-color:var(--accent)"><label for="np-kpi" style="font-size:11px;cursor:pointer">Jadikan KPI</label></div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">KPI Target (%)</label><input class="form-input" id="np-kpitarget" type="number" value="100"></div>
          <div class="form-group"><label class="form-label">Bobot KPI (%)</label><input class="form-input" id="np-kpiweight" type="number" value="10"></div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary" style="flex:1" onclick="saveNewProgram()"><i class="fa fa-save"></i> Simpan</button>
        <button class="btn" onclick="closeModalDirect()">Batal</button>
      </div>
    </div>

    <!-- FORM IMPORT DARI PENGADAAN -->
    <div id="progform-import" style="display:none">
      ${availablePO.length===0?`
        <div style="text-align:center;padding:30px;color:var(--t3)">
          <i class="fa fa-box-open" style="font-size:32px;margin-bottom:12px;display:block"></i>
          <div style="font-size:13px;margin-bottom:6px">Tidak ada PO yang tersedia untuk diimport</div>
          <div style="font-size:11px">Semua PO sudah terhubung ke Program Kerja, atau belum ada PO yang dibuat.</div>
        </div>`:`
        <div style="font-size:11px;color:var(--t3);margin-bottom:10px">
          Pilih satu atau lebih PO dari Pengadaan untuk dijadikan Program Kerja. Data akan tersinkronisasi otomatis.
        </div>
        <div style="max-height:350px;overflow-y:auto">
          ${availablePO.map(po=>{
            const jc=po.jenis==='Capex'?'var(--accent)':po.jenis==='Opex'?'var(--purple)':'var(--t3)';
            const u=DB.units.find(x=>x.id===po.unitId);
            return `<label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg3);border-radius:8px;margin-bottom:6px;cursor:pointer;border:1px solid var(--border)"
              onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
              <input type="checkbox" value="${po.id}" class="import-po-chk" style="width:16px;height:16px;accent-color:var(--accent);flex-shrink:0;margin-top:2px">
              <div style="flex:1">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap">
                  <span style="background:${jc}20;color:${jc};border:1px solid ${jc}40;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700">${po.jenis||'—'}</span>
                  <span style="font-size:12px;font-weight:600">${po.item}</span>
                </div>
                <div style="font-size:10px;color:var(--t3)">
                  <i class="fa fa-truck"></i> ${po.vendor||'—'} &nbsp;·&nbsp;
                  <i class="fa fa-building"></i> ${u?u.name:'—'} &nbsp;·&nbsp;
                  <strong style="color:${jc}">Rp ${po.value||0}Jt</strong> &nbsp;·&nbsp;
                  Due: ${po.due?new Date(po.due).toLocaleDateString('id-ID'):'—'}
                </div>
              </div>
            </label>`;
          }).join('')}
        </div>
        <div style="background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:8px;padding:10px 12px;font-size:11px;color:var(--success);margin:10px 0">
          <i class="fa fa-arrow-right-arrow-left"></i> PO yang diimport akan tersinkronisasi dua arah dengan Program Kerja secara otomatis.
        </div>
        <div style="display:flex;gap:8px;margin-top:4px">
          <button class="btn btn-primary" style="flex:1" onclick="importPOToProgram()"><i class="fa fa-file-import"></i> Import yang Dipilih</button>
          <button class="btn" onclick="closeModalDirect()">Batal</button>
        </div>`}
    </div>`;
  openModalDirect();
}

function switchProgTab(tab){
  document.getElementById('progform-manual').style.display=tab==='manual'?'block':'none';
  document.getElementById('progform-import').style.display=tab==='import'?'block':'none';
  document.getElementById('tab-manual').className='btn '+(tab==='manual'?'btn-primary':'');
  document.getElementById('tab-import').className='btn '+(tab==='import'?'btn-primary':'');
}

function importPOToProgram(){
  const checked=[...document.querySelectorAll('.import-po-chk:checked')].map(el=>el.value);
  if(!checked.length){alert('Pilih minimal satu PO');return;}
  let count=0;
  checked.forEach(poId=>{
    const po=DB.procurement.find(x=>x.id===poId); if(!po) return;
    // Cek jika sudah pernah diimport
    if(po.progId&&DB.programs.find(p=>p.id===po.progId)) return;
    const progId=uid();
    const prog={
      id:progId, name:'[Pengadaan] '+po.item,
      unitId:po.unitId, pic:po.vendor||'—',
      start:po.date||today(), end:po.due||today(),
      budget:po.budget||po.value||0, spent:po.spent||0,
      useAsKPI:false, kpiTarget:100, kpiWeight:10,
      status:po.status==='Delivered'?'On Track':po.delay>0?'Overdue':'In Progress',
      riskId:'', desc:'Import dari PO '+po.jenis+' vendor '+po.vendor+'. Nilai: Rp '+(po.value||0)+'Jt',
      progress:recalcProgressFromTasks({tasks:po.tasks}),
      tasks:JSON.parse(JSON.stringify(po.tasks||[])), // deep copy
      fromPO:po.id
    };
    po.progId=progId;
    DB.programs.push(prog);
    count++;
  });
  if(count===0){alert('PO yang dipilih sudah pernah diimport');return;}
  syncKPIsFromPrograms();scheduleSave();closeModalDirect();renderProgram();
  showToast(`✅ ${count} PO berhasil diimport ke Program Kerja`,'var(--success)');
}
function saveNewProgram(){const name=document.getElementById('np-name').value.trim();if(!name){alert('Nama wajib diisi');return;}DB.programs.push({id:uid(),name,unitId:document.getElementById('np-unit').value,pic:document.getElementById('np-pic').value,start:document.getElementById('np-start').value,end:document.getElementById('np-end').value,budget:parseFloat(document.getElementById('np-budget').value)||0,spent:0,useAsKPI:document.getElementById('np-kpi').checked,kpiTarget:parseFloat(document.getElementById('np-kpitarget').value)||100,kpiWeight:parseInt(document.getElementById('np-kpiweight').value)||10,status:document.getElementById('np-status').value,riskId:'',desc:'',progress:0,tasks:[]});syncKPIsFromPrograms();scheduleSave();closeModalDirect();renderProgram();}
function editProgram(id){
  const p=DB.programs.find(x=>x.id===id);if(!p)return;
  const budget=p.budget||0;
  const spent=p.spent||0;
  const pct=budget>0?Math.round(spent/budget*100):0;
  const pc=pct>=90?'var(--danger)':pct>=70?'var(--warn)':'var(--success)';
  document.getElementById('modal-title').textContent='Edit Program';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-group"><label class="form-label">Nama Program</label>
      <input class="form-input" id="ep-name" value="${p.name}"></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Unit</label>
        <select class="form-select" id="ep-unit">${DB.units.map(u=>`<option value="${u.id}"${u.id===p.unitId?' selected':''}>${u.name}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">PIC</label>
        <input class="form-input" id="ep-pic" value="${p.pic}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Tanggal Mulai</label>
        <input class="form-input" type="date" id="ep-start" value="${p.start}"></div>
      <div class="form-group"><label class="form-label">Deadline</label>
        <input class="form-input" type="date" id="ep-end" value="${p.end}"></div>
    </div>

    <!-- Anggaran -->
    <div style="background:rgba(26,140,255,.05);border:1px solid rgba(26,140,255,.15);border-radius:8px;padding:12px;margin:8px 0">
      <div style="font-size:10px;font-weight:700;color:var(--accent);margin-bottom:8px"><i class="fa fa-wallet"></i> ANGGARAN</div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Total Anggaran (Rp Juta)</label>
          <input class="form-input" type="number" id="ep-budget" value="${budget}" min="0"
            oninput="updateProgSpentPreview(document.getElementById('ep-spent').value,this.value)"></div>
        <div class="form-group"><label class="form-label">Anggaran Terpakai (Rp Juta)</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input class="form-input" type="number" id="ep-spent" value="${spent}" min="0" style="flex:1"
              oninput="updateProgSpentPreview(this.value,document.getElementById('ep-budget').value)">
            <button class="btn btn-sm btn-danger" onclick="document.getElementById('ep-spent').value=0;updateProgSpentPreview(0,document.getElementById('ep-budget').value)" title="Reset ke 0">
              <i class="fa fa-rotate-left"></i>
            </button>
          </div>
          <div id="prog-spent-preview" style="font-size:10px;margin-top:4px;color:${pc};font-weight:600">
            ${pct}% terpakai dari Rp ${budget}Jt${pct>=90?' ⚠️':''}
          </div>
        </div>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group"><label class="form-label">Status</label>
        <select class="form-select" id="ep-status">${['On Track','At Risk','In Progress','Overdue'].map(s=>`<option${s===p.status?' selected':''}>${s}</option>`).join('')}</select></div>
    </div>

    <div style="background:rgba(26,140,255,.06);border:1px solid rgba(26,140,255,.2);border-radius:8px;padding:12px;margin:8px 0">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input type="checkbox" id="ep-kpi" ${p.useAsKPI?'checked':''} style="width:14px;height:14px;accent-color:var(--accent)">
        <label for="ep-kpi" style="font-size:11px;cursor:pointer"><i class="fa fa-bullseye" style="color:var(--accent)"></i> Jadikan KPI</label>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">KPI Target (%)</label>
          <input class="form-input" id="ep-kpitarget" type="number" value="${p.kpiTarget||100}"></div>
        <div class="form-group"><label class="form-label">Bobot KPI (%)</label>
          <input class="form-input" id="ep-kpiweight" type="number" value="${p.kpiWeight||10}"></div>
      </div>
    </div>

    ${p.fromPO?`<div style="background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:8px;padding:10px 12px;font-size:11px;margin-bottom:6px">
      <div style="color:var(--success);font-weight:600;margin-bottom:4px"><i class="fa fa-arrow-right-arrow-left"></i> Sinkronisasi Dua Arah Aktif</div>
      <div style="color:var(--t2)">Program ini terhubung ke Pengadaan. Perubahan yang disimpan di sini akan otomatis diperbarui di menu Pengadaan, dan sebaliknya.</div>
    </div>`:''}

    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-primary" style="flex:1" onclick="saveProgram('${id}')"><i class="fa fa-save"></i> Simpan</button>
      <button class="btn" onclick="closeModalDirect()">Batal</button>
    </div>`;
  openModalDirect();
}

function updateProgSpentPreview(spent, budget){
  const el=document.getElementById('prog-spent-preview'); if(!el) return;
  const s=parseFloat(spent)||0, b=parseFloat(budget)||0;
  const pct=b>0?Math.round(s/b*100):0;
  const color=pct>=90?'var(--danger)':pct>=70?'var(--warn)':'var(--success)';
  el.style.color=color;
  el.innerHTML=`<strong>${pct}%</strong> terpakai dari Rp ${b}Jt${pct>=90?' <i class="fa fa-triangle-exclamation"></i> Hampir habis!':pct>=70?' <i class="fa fa-circle-exclamation"></i>':''}`;
}

function saveProgram(id){
  const p=DB.programs.find(x=>x.id===id);if(!p)return;
  p.name=document.getElementById('ep-name').value||p.name;
  p.unitId=document.getElementById('ep-unit').value;
  p.pic=document.getElementById('ep-pic').value;
  p.start=document.getElementById('ep-start').value;
  p.end=document.getElementById('ep-end').value;
  p.budget=parseFloat(document.getElementById('ep-budget').value)||0;
  p.spent=parseFloat(document.getElementById('ep-spent').value)||0;
  p.status=document.getElementById('ep-status').value;
  p.useAsKPI=document.getElementById('ep-kpi').checked;
  p.kpiTarget=parseFloat(document.getElementById('ep-kpitarget').value)||100;
  p.kpiWeight=parseInt(document.getElementById('ep-kpiweight').value)||10;
  p.progress=recalcProgressFromTasks(p);

  // Sinkron ke PO terkait jika ada
  if(p.fromPO){
    syncProgramToPO(id);
    showToast('✅ Tersinkronisasi ke Pengadaan', 'var(--success)');
  }

  syncKPIsFromPrograms();scheduleSave();closeModalDirect();renderProgram();
}

function deleteProgram(id){
  const p=DB.programs.find(x=>x.id===id);if(!p)return;
  if(!confirm(`Hapus program "${p.name}"?`))return;
  // Jika berasal dari PO, putus link
  if(p.fromPO){
    const po=DB.procurement.find(x=>x.id===p.fromPO);
    if(po) po.progId='';
  }
  DB.programs=DB.programs.filter(x=>x.id!==id);
  syncKPIsFromPrograms();scheduleSave();renderProgram();
}

// ═══════════════ RISK & EWS (SATU MENU) ═══════════════

// ═══════════════════════════════════════════════════
// RISK HELPER FUNCTIONS — Peta Risiko APA
// Probability: A(1)=Sangat Jarang → E(5)=Hampir Pasti
// Impact: 1=Sangat Rendah → 5=Sangat Tinggi
// Score BUKAN perkalian biasa — sesuai tabel standar APA
// ═══════════════════════════════════════════════════
const LIKELIHOOD_LABELS = {1:'A',2:'B',3:'C',4:'D',5:'E'};
const LIKELIHOOD_DESC   = {
  1:'A – Sangat Jarang / Very Rarely Occurs',
  2:'B – Jarang Terjadi / Rarely Occurs',
  3:'C – Bisa Terjadi / May Occur',
  4:'D – Sangat Mungkin / Very Likely to Occur',
  5:'E – Hampir Pasti Terjadi / Almost Certain to Occur'
};
const IMPACT_DESC = {
  1:'1 – Sangat Rendah / Very Low',
  2:'2 – Rendah / Low',
  3:'3 – Moderat / Moderate',
  4:'4 – Tinggi / High',
  5:'5 – Sangat Tinggi / Very High'
};

// Tabel score resmi APA — [probability 1-5][impact 1-5]
const APA_SCORE_TABLE = {
  1: {1:1,  2:5,  3:10, 4:15, 5:20},  // A
  2: {1:2,  2:6,  3:11, 4:16, 5:21},  // B
  3: {1:3,  2:8,  3:13, 4:18, 5:23},  // C
  4: {1:4,  2:9,  3:14, 4:19, 5:24},  // D
  5: {1:7,  2:12, 3:17, 4:22, 5:25},  // E
};

function riskScore(r){
  const li = r.likelihood||1, im = r.impact||1;
  return (APA_SCORE_TABLE[li]||{})[im] || (li*im);
}
function riskLevelAPA(score){
  if(score>=20) return 'High';
  if(score>=16) return 'Moderate to High';
  if(score>=12) return 'Moderate';
  if(score>=6)  return 'Low to Moderate';
  return 'Low';
}
function riskColorAPA(score){
  if(score>=20) return '#c62828';  // merah
  if(score>=16) return '#ef6c00';  // orange
  if(score>=12) return '#f9a825';  // kuning
  if(score>=6)  return '#7cb342';  // hijau muda
  return '#2e7d32';                // hijau tua
}
function matrixCellColor(prob, impact){
  return riskColorAPA(( APA_SCORE_TABLE[prob]||{} )[impact] || prob*impact);
}
function matrixScore(prob, impact){
  return (APA_SCORE_TABLE[prob]||{})[impact] || prob*impact;
}

function renderRisk(){
  const cont=document.getElementById('content');
  const at=cont.getAttribute('data-rtab')||'register';
  cont.setAttribute('data-rtab',at);

  const high=DB.risks.filter(r=>riskScore(r)>=20).length;
  const modHigh=DB.risks.filter(r=>{const s=riskScore(r);return s>=16&&s<20;}).length;
  const mod=DB.risks.filter(r=>{const s=riskScore(r);return s>=12&&s<16;}).length;
  const lowMod=DB.risks.filter(r=>{const s=riskScore(r);return s>=6&&s<12;}).length;
  const low=DB.risks.filter(r=>riskScore(r)<6).length;
  const ewsActive=DB.ews.filter(e=>!e.acked).length;

  cont.innerHTML=`
  <div class="stat-row">
    <div class="stat-box"><div class="sl">Total Risiko</div><div class="sv">${DB.risks.length}</div></div>
    <div class="stat-box" style="border-left:3px solid #d32f2f"><div class="sl">High (20-25)</div><div class="sv" style="color:#d32f2f">${high}</div></div>
    <div class="stat-box" style="border-left:3px solid #f57c00"><div class="sl">Mod. to High (16-19)</div><div class="sv" style="color:#f57c00">${modHigh}</div></div>
    <div class="stat-box" style="border-left:3px solid #f9c02e"><div class="sl">Moderate (12-15)</div><div class="sv" style="color:#c8a000">${mod}</div></div>
    <div class="stat-box" style="border-left:3px solid #8bc34a"><div class="sl">Low to Mod. (6-11)</div><div class="sv" style="color:#558b2f">${lowMod}</div></div>
    <div class="stat-box" style="border-left:3px solid #2e7d32"><div class="sl">Low (1-5)</div><div class="sv" style="color:#2e7d32">${low}</div></div>
    <div class="stat-box" style="border-left:3px solid #ff3b3b"><div class="sl">EWS Aktif</div><div class="sv" style="color:var(--danger)">${ewsActive}</div><div class="sv-sub">Belum di-ACK</div></div>
  </div>

  <div class="tabs">
    <button class="tab ${at==='register'?'active':''}" onclick="setRiskTab('register',this)"><i class="fa fa-list"></i> Risk Register</button>
    <button class="tab ${at==='matrix'?'active':''}" onclick="setRiskTab('matrix',this)"><i class="fa fa-table-cells"></i> Peta Risiko</button>
    <button class="tab ${at==='ews'?'active':''}" onclick="setRiskTab('ews',this)"><i class="fa fa-triangle-exclamation"></i> EWS Alerts ${ewsActive?`<span style="background:var(--danger);color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:8px;margin-left:3px">${ewsActive}</span>`:''}</button>
  </div>
  <div id="risk-tab-content"></div>`;

  renderRiskTab(at);
}

function setRiskTab(tab,btn){
  document.getElementById('content').setAttribute('data-rtab',tab);
  document.querySelectorAll('.tabs .tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderRiskTab(tab);
}

function renderRiskTab(tab){
  const el=document.getElementById('risk-tab-content');

  if(tab==='register'){
    const {bar:rBar,filtered:rFiltered,groups:rGroups,showHeader:rShowHeader}=buildFilterBar('Risk',DB.risks,r=>r.due||'',r=>r.unitId||'');
    const sorted=[...rFiltered].sort((a,b)=>riskScore(b)-riskScore(a));
    el.innerHTML=`
    ${rBar}
    <div class="panel">
      <div class="panel-hd"><div class="panel-title">Risk Register — diurutkan berdasarkan Level ${rFiltered.length!==DB.risks.length?`<span class="badge badge-blue">${rFiltered.length} dari ${DB.risks.length}</span>`:''}</div></div>
      ${sorted.map(r=>{
        const s=riskScore(r);
        const lv=riskLevelAPA(s);
        const color=riskColorAPA(s);
        return `<div style="background:var(--bg3);border-radius:8px;padding:14px;margin-bottom:10px;border-left:4px solid ${color}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div style="flex:1">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">
                <span style="background:${color};color:${s>=12&&s<16?'#333':'#fff'};padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700"><i class="fa fa-triangle-exclamation"></i> ${lv}</span>
                <span style="font-size:11px;font-weight:700;color:${color}">Score: ${s}</span>
                <span style="background:var(--bg4);border:1px solid var(--border2);padding:2px 8px;border-radius:10px;font-size:10px;color:var(--t2)">
                  <strong>L:</strong> ${LIKELIHOOD_LABELS[r.likelihood]||r.likelihood} &nbsp;×&nbsp; <strong>I:</strong> ${r.impact}
                </span>
                <span class="badge badge-purple">${r.cat}</span>
                <span class="badge ${r.status==='Open'?'badge-blue':r.status==='Mitigated'?'badge-teal':'badge-green'}">${r.status}</span>
              </div>
              <div style="font-size:13px;font-weight:600;margin-bottom:5px">${r.desc}</div>
              <div style="font-size:10px;color:var(--t3);margin-bottom:4px"><i class="fa fa-magnifying-glass"></i> Penyebab:
                ${r.causes&&r.causes.length
                  ? r.causes.map(c=>`<span style="display:inline-block;background:var(--bg4);border-radius:4px;padding:1px 6px;margin:1px;font-size:10px">${c.text}</span>`).join('')
                  : r.cause||'—'}
              </div>
              <div style="font-size:10px;color:var(--t3);margin-bottom:4px">
                <span style="margin-right:12px">Kemungkinan: <strong style="color:var(--t1)">${LIKELIHOOD_LABELS[r.likelihood]||r.likelihood} – ${['','Sangat Jarang','Jarang','Bisa Terjadi','Sangat Mungkin','Hampir Pasti'][r.likelihood]||'—'}</strong></span>
                <span style="margin-right:12px">Dampak: <strong style="color:var(--t1)">${r.impact} – ${['','Sangat Rendah','Rendah','Moderat','Tinggi','Sangat Tinggi'][r.impact]||'—'}</strong></span>
                <span>PIC: <strong style="color:var(--t1)">${r.pic}</strong></span>
                ${r.due?`<span style="margin-left:12px">Due: <strong style="color:${isOverdue(r.due)?'var(--danger)':'var(--t1)'}">${fmtDate(r.due)}</strong></span>`:''}
              </div>
              <div style="background:rgba(255,255,255,.04);border-radius:5px;padding:6px 8px;margin-top:4px">
                <div style="font-size:10px;color:var(--accent);margin-bottom:4px"><i class="fa fa-shield"></i> Mitigasi:</div>
                ${r.mitigations&&r.mitigations.length
                  ? `${r.mitigations.map(m=>`<div style="display:flex;align-items:center;gap:6px;padding:2px 0">
                      <span style="color:${m.done?'var(--success)':'var(--t3)'};font-size:11px">${m.done?'✓':'○'}</span>
                      <span style="font-size:11px;${m.done?'text-decoration:line-through;color:var(--t3)':''}">${m.text}</span>
                    </div>`).join('')}
                    <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                      <div class="prog-bar-wrap" style="height:4px"><div class="prog-bar" style="width:${r.mitigations.length?Math.round(r.mitigations.filter(m=>m.done).length/r.mitigations.length*100):0}%;background:var(--success)"></div></div>
                      <span style="font-size:10px;color:var(--t3)">${r.mitigations.filter(m=>m.done).length}/${r.mitigations.length}</span>
                    </div>`
                  : `<em style="font-size:11px;color:var(--t3)">${r.mitigation||'—'}</em>`}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">
              <button class="btn btn-sm" onclick="editRisk('${r.id}')"><i class="fa fa-pen"></i></button>
              <button class="btn btn-sm btn-danger" onclick="deleteRisk('${r.id}')"><i class="fa fa-trash"></i></button>
              <button class="btn btn-sm" onclick="moveItem('risks','${r.id}',-1)" title="Pindah ke atas" style="padding:2px 6px"><i class="fa fa-chevron-up" style="font-size:9px"></i></button>
              <button class="btn btn-sm" onclick="moveItem('risks','${r.id}',1)" title="Pindah ke bawah" style="padding:2px 6px"><i class="fa fa-chevron-down" style="font-size:9px"></i></button>
            </div>
          </div>
        </div>`;}).join('')||'<div style="text-align:center;color:var(--t3);padding:30px">Belum ada risiko terdaftar.</div>'}
    </div>`;
  }
  else if(tab==='matrix'){
    // Build matrix[prob][impact] = array of risks (prob=1-5=A-E, impact=1-5)
    const matrix={};
    for(let p=1;p<=5;p++){matrix[p]={};for(let i=1;i<=5;i++)matrix[p][i]=[];}
    DB.risks.forEach(r=>{
      const p=r.likelihood,i=r.impact;
      if(p>=1&&p<=5&&i>=1&&i<=5) matrix[p][i]=[...matrix[p][i],r];
    });
    const levels=[
      {lv:'High',          range:'20–25',color:'#c62828',tc:'#fff'},
      {lv:'Moderate to High',range:'16–19',color:'#ef6c00',tc:'#fff'},
      {lv:'Moderate',      range:'12–15',color:'#f9a825',tc:'#333'},
      {lv:'Low to Moderate',range:'6–11', color:'#7cb342',tc:'#fff'},
      {lv:'Low',           range:'1–5',  color:'#2e7d32',tc:'#fff'},
    ];

    el.innerHTML=`
    <div class="panel" style="overflow-x:auto">
      <div class="panel-hd"><div class="panel-title">Peta Risiko — Risk Matrix 5×5</div><div class="panel-sub">Standar PT Angkasa Pura Aviasi · Klik sel untuk detail</div></div>
      <table style="border-collapse:separate;border-spacing:4px;margin:0 auto">
        <thead>
          <tr>
            <td style="min-width:32px"></td>
            <td style="min-width:120px;padding-bottom:4px"></td>
            <td colspan="5" style="text-align:center;font-size:10px;font-weight:700;color:var(--t2);letter-spacing:.5px;padding-bottom:6px;border-bottom:1px solid var(--border)">
              TINGKAT DAMPAK / IMPACT LEVEL
            </td>
          </tr>
          <tr>
            <td style="text-align:center;padding-bottom:4px;vertical-align:bottom">
              <div style="writing-mode:vertical-lr;transform:rotate(180deg);font-size:9px;font-weight:700;color:var(--t2);letter-spacing:.5px;white-space:nowrap;height:60px">KEMUNGKINAN</div>
            </td>
            <td></td>
            ${[1,2,3,4,5].map(i=>`<td style="text-align:center;padding:4px 2px;min-width:90px">
              <div style="font-size:14px;font-weight:800;color:var(--t1)">${i}</div>
              <div style="font-size:9px;color:var(--t3)">${['Sangat Rendah','Rendah','Moderat','Tinggi','Sangat Tinggi'][i-1]}</div>
              <div style="font-size:8px;color:var(--t3);font-style:italic">${['Very Low','Low','Moderate','High','Very High'][i-1]}</div>
            </td>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${[5,4,3,2,1].map(prob=>{
            const names=['','Sangat Jarang Terjadi','Jarang Terjadi','Bisa Terjadi','Sangat Mungkin Terjadi','Hampir Pasti Terjadi'];
            const engs=['','Very Rarely Occurs','Rarely Occurs','May Occur','Very Likely to Occur','Almost Certain to Occur'];
            return `<tr>
              <td style="text-align:center;vertical-align:middle;padding:2px 6px">
                <div style="font-size:15px;font-weight:800;color:var(--t1)">${LIKELIHOOD_LABELS[prob]}</div>
              </td>
              <td style="padding:2px 8px;vertical-align:middle">
                <div style="font-size:9px;font-weight:600;color:var(--t2)">${names[prob]}</div>
                <div style="font-size:8px;color:var(--t3);font-style:italic">${engs[prob]}</div>
              </td>
              ${[1,2,3,4,5].map(impact=>{
                const s=matrixScore(prob,impact);
                const lv=riskLevelAPA(s);
                const bg=matrixCellColor(prob,impact);
                const tc=s>=12&&s<16?'#333':'#fff';
                const risks=matrix[prob][impact]||[];
                return `<td style="padding:2px">
                  <div onclick="showMatrixRisks(${prob},${impact})"
                    style="width:90px;height:62px;background:${bg};border-radius:5px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;transition:.12s;border:2px solid transparent"
                    onmouseover="this.style.borderColor='rgba(255,255,255,.7)';this.style.transform='scale(1.05)'"
                    onmouseout="this.style.borderColor='transparent';this.style.transform='scale(1)'"
                    title="${lv} — Score ${s}${risks.length?' | '+risks.length+' risiko':''}">
                    <div style="font-size:9px;font-weight:700;color:${tc};text-align:center;line-height:1.2;padding:0 3px">${lv}</div>
                    <div style="font-size:18px;font-weight:900;color:${tc};line-height:1">${s}</div>
                    ${risks.length?`<div style="font-size:9px;color:${tc};font-weight:600">● ${risks.length}</div>`:''}
                  </div>
                </td>`;}).join('')}
            </tr>`;}).join('')}
        </tbody>
      </table>
      <!-- Legend -->
      <div style="margin-top:14px;padding:12px;background:var(--bg3);border-radius:8px;display:flex;flex-wrap:wrap;gap:12px;align-items:center">
        ${levels.map(({lv,range,color,tc})=>{
          const cnt=DB.risks.filter(r=>riskLevelAPA(riskScore(r))===lv).length;
          return `<div style="display:flex;align-items:center;gap:8px">
            <div style="background:${color};min-width:56px;height:22px;border-radius:4px;display:flex;align-items:center;justify-content:center;padding:0 6px">
              <span style="font-size:10px;font-weight:700;color:${tc}">${range}</span>
            </div>
            <span style="font-size:11px;color:var(--t1);font-weight:500">${lv}</span>
            <span style="font-size:10px;color:var(--t3)">(${cnt})</span>
          </div>`;}).join('')}
      </div>
    </div>
    <!-- Distribusi -->
    <div class="panel">
      <div class="panel-hd"><div class="panel-title">Distribusi Risiko per Level</div></div>
      ${levels.map(({lv,range,color})=>{
        const risks=DB.risks.filter(r=>riskLevelAPA(riskScore(r))===lv);
        return `<div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <div style="display:flex;align-items:center;gap:8px">
              <div style="width:12px;height:12px;border-radius:2px;background:${color}"></div>
              <span style="font-size:12px;font-weight:600;color:${color}">${lv}</span>
              <span style="font-size:10px;color:var(--t3)">Score ${range}</span>
            </div>
            <span style="font-size:14px;font-weight:700;color:${color}">${risks.length}</span>
          </div>
          <div class="prog-bar-wrap" style="height:7px"><div class="prog-bar" style="width:${DB.risks.length?Math.round(risks.length/DB.risks.length*100):0}%;background:${color}"></div></div>
          ${risks.length?`<div style="margin-top:4px">${risks.map(r=>`<div style="font-size:10px;color:var(--t3);padding:2px 0;border-bottom:1px dashed rgba(255,255,255,.05)">· ${LIKELIHOOD_LABELS[r.likelihood]}${r.impact} — ${r.desc.length>55?r.desc.substring(0,55)+'…':r.desc}</div>`).join('')}</div>`:''}
        </div>`;}).join('')}
    </div>
    <div class="panel" id="matrix-detail" style="display:none">
      <div class="panel-hd">
        <div><div class="panel-title" id="matrix-detail-title">Risiko pada Sel</div><div class="panel-sub" id="matrix-detail-sub"></div></div>
        <button class="btn btn-sm" onclick="document.getElementById('matrix-detail').style.display='none'"><i class="fa fa-xmark"></i></button>
      </div>
      <div id="matrix-detail-body"></div>
    </div>`;
  }
  else{ // ews tab
    const active=DB.ews.filter(e=>!e.acked);
    el.innerHTML=`
    <div style="background:rgba(26,140,255,.05);border:1px solid rgba(26,140,255,.2);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:11px;color:var(--t2);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <i class="fa fa-circle-info" style="color:var(--accent)"></i>
      <span>EWS dibuat dari <strong>Program Kerja</strong> (At Risk/Overdue) atau <strong>Risk Register</strong> (berdasarkan score). Pilih item yang ingin dijadikan EWS Alert.</span>
      <button class="btn btn-sm btn-primary" onclick="openPickEWSModal()" style="margin-left:auto"><i class="fa fa-hand-pointer"></i> Pilih dari Program / Risk</button>
    </div>
    <div class="grid-2">
      <div class="panel">
        <div class="panel-hd"><div class="panel-title"><i class="fa fa-triangle-exclamation" style="color:var(--danger)"></i> Active EWS Alerts</div></div>
        ${active.length?active.map(e=>`
          <div class="ews-item ${e.level==='High'||e.level==='Moderate to High'?'extreme':e.level==='Moderate'?'high':e.level==='Low to Moderate'?'medium':'low'}" style="border-left-color:${e.level==='High'?'#d32f2f':e.level==='Moderate to High'?'#f57c00':e.level==='Moderate'?'#f9c02e':e.level==='Low to Moderate'?'#8bc34a':'#2e7d32'}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
              <div style="flex:1">
                <div style="display:flex;align-items:center;gap:5px;margin-bottom:4px;flex-wrap:wrap">
                  <span style="background:${e.level==='High'?'#d32f2f':e.level==='Moderate to High'?'#f57c00':e.level==='Moderate'?'#f9c02e':e.level==='Low to Moderate'?'#8bc34a':'#2e7d32'};color:${e.level==='Moderate'?'#333':'#fff'};padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">${e.level}</span>
                  <span class="badge badge-purple">${e.cat}</span>
                  ${e.sourceType==='program'?'<span class="badge badge-blue"><i class="fa fa-list-check"></i> Program</span>':e.sourceType==='risk'?'<span class="badge badge-teal"><i class="fa fa-shield-halved"></i> Risk</span>':''}
                </div>
                <div style="font-size:12px;font-weight:500;margin-bottom:3px">${e.desc}</div>
                <div style="font-size:10px;color:var(--t3)">Trigger: ${e.trigger||'—'} &nbsp;·&nbsp; <i class="fa fa-user"></i> ${e.assigned} &nbsp;·&nbsp; ${e.time}</div>
              </div>
              <button class="btn btn-sm btn-success" onclick="ackEWS('${e.id}')"><i class="fa fa-check"></i> ACK</button>
            </div>
          </div>`).join(''):'<div style="text-align:center;color:var(--t3);padding:24px"><i class="fa fa-check-circle" style="font-size:24px;color:var(--success)"></i><div style="margin-top:8px">Tidak ada alert aktif</div></div>'}
      </div>
      <div class="panel">
        <div class="panel-hd"><div class="panel-title" style="color:var(--t3)"><i class="fa fa-clock-rotate-left"></i> Sudah di-ACK</div></div>
        ${DB.ews.filter(e=>e.acked).length?`<table class="tbl"><thead><tr><th>Deskripsi</th><th>Level</th><th>Kategori</th><th>Waktu</th></tr></thead><tbody>
          ${DB.ews.filter(e=>e.acked).map(e=>`<tr style="opacity:.5"><td>${e.desc}</td><td><span style="font-size:10px;font-weight:600">${e.level}</span></td><td><span class="badge badge-purple">${e.cat}</span></td><td style="color:var(--t3)">${e.time}</td></tr>`).join('')}
        </tbody></table>`:'<div style="text-align:center;color:var(--t3);padding:20px">Belum ada</div>'}
      </div>
    </div>`;
  }
}

function showMatrixRisks(prob, impact){
  const s = matrixScore(prob, impact);
  const lv = riskLevelAPA(s);
  const color = matrixCellColor(prob, impact);
  const tc = s>=12&&s<16?'#333':'#fff';
  const risks = DB.risks.filter(r=>r.likelihood===prob&&r.impact===impact);
  const det = document.getElementById('matrix-detail');
  document.getElementById('matrix-detail-title').innerHTML =
    `<span style="background:${color};color:${tc};padding:3px 12px;border-radius:12px;font-size:12px;font-weight:700">${lv}</span>` +
    `&nbsp;&nbsp;Score <strong>${s}</strong> &nbsp;&middot;&nbsp; Kemungkinan: <strong>${LIKELIHOOD_LABELS[prob]}</strong> &nbsp;&times;&nbsp; Dampak: <strong>${impact}</strong>`;
  document.getElementById('matrix-detail-sub').textContent =
    risks.length ? risks.length+' risiko pada posisi ini' : 'Tidak ada risiko pada posisi ini';
  document.getElementById('matrix-detail-body').innerHTML = risks.length
    ? risks.map(r=>`<div style="background:var(--bg3);border-radius:6px;padding:10px 12px;margin-bottom:6px;border-left:3px solid ${color}">
        <div style="font-size:12px;font-weight:600;margin-bottom:3px">${r.desc}</div>
        <div style="font-size:10px;color:var(--t3)"><span class="badge badge-purple" style="font-size:9px">${r.cat}</span> &nbsp;PIC: ${r.pic} &nbsp;&middot;&nbsp; Status: ${r.status}</div>
        <div style="font-size:10px;color:var(--t3);margin-top:3px"><i class="fa fa-shield" style="color:var(--accent)"></i> ${r.mitigation||'—'}</div>
      </div>`).join('')
    : '<div style="color:var(--t3);text-align:center;padding:16px">Tidak ada risiko pada posisi ini</div>';
  det.style.display = 'block';
  det.scrollIntoView({behavior:'smooth', block:'nearest'});
}

function ackEWS(id){const e=DB.ews.find(x=>x.id===id);if(e){e.acked=true;scheduleSave();renderRisk();updateBadges();}}

function openPickEWSModal(){
  document.getElementById('modal-title').textContent='Tambah EWS — Pilih dari Program / Risk';
  const progAtRisk=DB.programs.filter(p=>p.status==='At Risk'||p.status==='Overdue'||isOverdue(p.end));
  const riskList=[...DB.risks].sort((a,b)=>riskScore(b)-riskScore(a));

  function riskLv(r){return riskLevelAPA(riskScore(r));}
  function riskBadge(lv){return lv==='High'||lv==='Moderate to High'?'badge-red':lv==='Moderate'?'badge-yellow':'badge-green';}
  function progLv(p){return p.status==='Overdue'||isOverdue(p.end)?'High':p.status==='At Risk'?'Medium':'Low';}

  document.getElementById('modal-body').innerHTML=`
    <div class="tabs" style="margin-bottom:12px">
      <button class="tab active" id="pick-tab-prog" onclick="switchPickTab('prog')"><i class="fa fa-list-check"></i> Program Kerja</button>
      <button class="tab" id="pick-tab-risk" onclick="switchPickTab('risk')"><i class="fa fa-shield-halved"></i> Risk Register</button>
    </div>

    <!-- Program tab -->
    <div id="pick-prog">
      ${progAtRisk.length?progAtRisk.map(p=>{
        const lv=progLv(p);
        const dl=daysLeft(p.end);
        const alreadyEWS=DB.ews.some(e=>e.sourceId===p.id&&!e.acked);
        return `<div style="background:var(--bg3);border-radius:8px;padding:12px;margin-bottom:8px;border-left:3px solid ${lv==='High'?'var(--danger)':'var(--warn)'}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div style="flex:1">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;flex-wrap:wrap">
                <span class="badge badge-${lv==='High'?'red':'yellow'}">${lv}</span>
                <span class="badge badge-purple">${p.status}</span>
                <span style="font-size:10px;color:var(--t3)">${unitName(p.unitId)}</span>
              </div>
              <div style="font-size:12px;font-weight:600;margin-bottom:3px">${p.name}</div>
              <div style="font-size:10px;color:var(--t3)">
                Progress: <strong style="color:${progColor(p.progress)}">${p.progress}%</strong> &nbsp;·&nbsp;
                PIC: ${p.pic} &nbsp;·&nbsp;
                Deadline: <strong style="color:${dl<0?'var(--danger)':dl<=7?'var(--warn)':'var(--t3)'}">${fmtDate(p.end)}</strong>
              </div>
            </div>
            ${alreadyEWS
              ?`<span class="badge badge-teal" style="flex-shrink:0"><i class="fa fa-check"></i> EWS Aktif</span>`
              :`<button class="btn btn-sm btn-primary" onclick="addEWSFromProgram('${p.id}')" style="flex-shrink:0"><i class="fa fa-triangle-exclamation"></i> Jadikan EWS</button>`}
          </div>
        </div>`;}).join('')
        :`<div style="text-align:center;color:var(--t3);padding:24px"><i class="fa fa-check-circle" style="color:var(--success);font-size:20px"></i><div style="margin-top:8px">Tidak ada program At Risk / Overdue</div></div>`}
    </div>

    <!-- Risk tab -->
    <div id="pick-risk" style="display:none">
      ${riskList.length?riskList.map(r=>{
        const lv=riskLv(r);
        const s=r.likelihood*r.impact;
        const alreadyEWS=DB.ews.some(e=>e.sourceId===r.id&&!e.acked);
        return `<div style="background:var(--bg3);border-radius:8px;padding:12px;margin-bottom:8px;border-left:3px solid ${riskColorAPA(s)}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div style="flex:1">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;flex-wrap:wrap">
                <span style="background:${riskColorAPA(s)};color:${s>=12&&s<16?'#333':'#fff'};padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">${lv}</span>
                <span style="font-size:11px;font-weight:700;color:${riskColorAPA(s)}">Score ${s}</span>
                <span style="font-size:10px;color:var(--t3)">${LIKELIHOOD_LABELS[r.likelihood]||r.likelihood} × ${r.impact}</span>
                <span class="badge badge-purple">${r.cat}</span>
                <span class="badge ${r.status==='Open'?'badge-blue':'badge-teal'}">${r.status}</span>
              </div>
              <div style="font-size:12px;font-weight:600;margin-bottom:3px">${r.desc}</div>
              <div style="font-size:10px;color:var(--t3)">PIC: ${r.pic} &nbsp;·&nbsp; Mitigasi: ${(r.mitigation||'—').substring(0,40)}</div>
            </div>
            ${alreadyEWS
              ?`<span class="badge badge-teal" style="flex-shrink:0"><i class="fa fa-check"></i> EWS Aktif</span>`
              :`<button class="btn btn-sm btn-primary" onclick="addEWSFromRisk('${r.id}')" style="flex-shrink:0"><i class="fa fa-triangle-exclamation"></i> Jadikan EWS</button>`}
          </div>
        </div>`;}).join('')
        :`<div style="text-align:center;color:var(--t3);padding:24px">Belum ada risk register.</div>`}
    </div>

    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
      <button class="btn" onclick="closeModalDirect()" style="width:100%;justify-content:center">Tutup</button>
    </div>`;
  openModalDirect();
}

function switchPickTab(tab){
  document.getElementById('pick-prog').style.display=tab==='prog'?'block':'none';
  document.getElementById('pick-risk').style.display=tab==='risk'?'block':'none';
  document.getElementById('pick-tab-prog').classList.toggle('active',tab==='prog');
  document.getElementById('pick-tab-risk').classList.toggle('active',tab==='risk');
}

function addEWSFromProgram(progId){
  const p=DB.programs.find(x=>x.id===progId);if(!p)return;
  const dl=daysLeft(p.end);
  const lv=p.status==='Overdue'||dl<0?'High':'Medium';
  DB.ews.push({
    id:uid(),
    desc:`Program "${p.name}" — ${p.status==='Overdue'||dl<0?'OVERDUE':'At Risk'} (Progress: ${p.progress}%)`,
    cat:'Program Kerja',level:lv,
    trigger:`Status: ${p.status}, Deadline: ${fmtDate(p.end)}`,
    time:new Date().toLocaleTimeString('id-ID'),
    assigned:p.pic,acked:false,auto:true,sourceId:progId,sourceType:'program'
  });
  scheduleSave();scheduleSave();updateBadges();
  // Refresh modal
  openPickEWSModal();
}

function addEWSFromRisk(riskId){
  const r=DB.risks.find(x=>x.id===riskId);if(!r)return;
  const s=riskScore(r);
  const lv=riskLevelAPA(s);
  DB.ews.push({
    id:uid(),
    desc:`Risk: ${r.desc}`,
    cat:'Risk',level:lv,
    trigger:`Risk Score: ${s} (${LIKELIHOOD_LABELS[r.likelihood]||r.likelihood}×${r.impact}) — ${r.cat}`,
    time:new Date().toLocaleTimeString('id-ID'),
    assigned:r.pic,acked:false,auto:true,sourceId:riskId,sourceType:'risk'
  });
  scheduleSave();updateBadges();
  openPickEWSModal();
}

function openRiskForm(){
  document.getElementById('modal-title').textContent='Tambah Risiko';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-group"><label class="form-label">Deskripsi Risiko</label><textarea class="form-textarea" id="nr-desc" placeholder="Uraikan risiko..."></textarea></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Kategori</label><select class="form-select" id="nr-cat"><option>Operational</option><option>Financial</option><option>HSE</option><option>Supply Chain</option><option>Compliance</option></select></div>
      <div class="form-group"><label class="form-label">PIC</label><input class="form-input" id="nr-pic" placeholder="Nama PIC"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Tingkat Kemungkinan (Probability)</label>
        <select class="form-select" id="nr-like">
          <option value="1">A – Sangat Jarang / Very Rarely Occurs</option>
          <option value="2">B – Jarang Terjadi / Rarely Occurs</option>
          <option value="3" selected>C – Bisa Terjadi / May Occur</option>
          <option value="4">D – Sangat Mungkin / Very Likely</option>
          <option value="5">E – Hampir Pasti / Almost Certain</option>
        </select></div>
      <div class="form-group"><label class="form-label">Tingkat Dampak (Impact)</label>
        <select class="form-select" id="nr-impact">
          <option value="1">1 – Sangat Rendah / Very Low</option>
          <option value="2">2 – Rendah / Low</option>
          <option value="3" selected>3 – Moderat / Moderate</option>
          <option value="4">4 – Tinggi / High</option>
          <option value="5">5 – Sangat Tinggi / Very High</option>
        </select></div>
    </div>
    <div id="nr-score-preview" style="background:var(--bg3);border-radius:8px;padding:10px;text-align:center;margin-bottom:6px">
      <span style="font-size:11px;color:var(--t3)">Risk Score: </span>
      <span id="nr-score-val" style="font-size:20px;font-weight:800">9</span>
      <span id="nr-level-val" style="font-size:11px;margin-left:8px"></span>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Penyebab</label><input class="form-input" id="nr-cause" placeholder="Root cause"></div>
      <div class="form-group"><label class="form-label">Due Date</label><input class="form-input" type="date" id="nr-due"></div>
    </div>
    <div class="form-group"><label class="form-label">Rencana Mitigasi</label><textarea class="form-textarea" id="nr-mit" placeholder="Langkah mitigasi..."></textarea></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-primary" style="flex:1" onclick="saveNewRisk()"><i class="fa fa-save"></i> Simpan</button>
      <button class="btn" onclick="closeModalDirect()">Batal</button>
    </div>`;
  openModalDirect();
  // Live score preview
  const updatePreview=()=>{
    const s=parseInt(document.getElementById('nr-like').value)*parseInt(document.getElementById('nr-impact').value);
    const lv=riskLevelAPA(s);const color=riskColorAPA(s);
    document.getElementById('nr-score-val').textContent=s;
    document.getElementById('nr-score-val').style.color=color;
    document.getElementById('nr-level-val').textContent=lv;
    document.getElementById('nr-level-val').style.color=color;
    document.getElementById('nr-score-preview').style.borderLeft=`4px solid ${color}`;
  };
  document.getElementById('nr-like').addEventListener('change',updatePreview);
  document.getElementById('nr-impact').addEventListener('change',updatePreview);
  updatePreview();
}
function saveNewRisk(){const desc=document.getElementById('nr-desc').value.trim();if(!desc){alert('Deskripsi wajib');return;}const like=parseInt(document.getElementById('nr-like').value),impact=parseInt(document.getElementById('nr-impact').value),s=like*impact;const r={id:uid(),cat:document.getElementById('nr-cat').value,desc,cause:document.getElementById('nr-cause').value,impact,likelihood:like,mitigation:document.getElementById('nr-mit').value,pic:document.getElementById('nr-pic').value,due:document.getElementById('nr-due').value,status:'Open',progId:''};DB.risks.push(r);if(s>=6)DB.ews.push({id:uid(),desc:`[Auto-EWS] ${desc}`,cat:'Risk',level:riskLevelAPA(s),trigger:`Risk Score: ${s} (${LIKELIHOOD_LABELS[like]}×${impact}) — ${riskLevelAPA(s)}`,time:new Date().toLocaleTimeString('id-ID'),assigned:r.pic,acked:false,auto:true});scheduleSave();closeModalDirect();renderRisk();updateBadges();}
function editRisk(id){const r=DB.risks.find(x=>x.id===id);if(!r)return;document.getElementById('modal-title').textContent='Edit Risiko';document.getElementById('modal-body').innerHTML=`<div class="form-group"><label class="form-label">Deskripsi</label><textarea class="form-textarea" id="er-desc">${r.desc}</textarea></div><div class="form-row"><div class="form-group"><label class="form-label">Kategori</label><select class="form-select" id="er-cat">${['Operational','Financial','HSE','Supply Chain','Compliance'].map(c=>`<option${c===r.cat?' selected':''}>${c}</option>`).join('')}</select></div><div class="form-group"><label class="form-label">Status</label><select class="form-select" id="er-status">${['Open','Mitigated','Closed'].map(s=>`<option${s===r.status?' selected':''}>${s}</option>`).join('')}</select></div></div><div class="form-row"><div class="form-group"><label class="form-label">Kemungkinan (Probability)</label><select class="form-select" id="er-like"><option value="1"${r.likelihood===1?' selected':''}>A – Sangat Jarang</option><option value="2"${r.likelihood===2?' selected':''}>B – Jarang Terjadi</option><option value="3"${r.likelihood===3?' selected':''}>C – Bisa Terjadi</option><option value="4"${r.likelihood===4?' selected':''}>D – Sangat Mungkin</option><option value="5"${r.likelihood===5?' selected':''}>E – Hampir Pasti</option></select></div><div class="form-group"><label class="form-label">Dampak (Impact)</label><select class="form-select" id="er-impact">${[1,2,3,4,5].map(n=>`<option${n===r.impact?' selected':''}>${n}</option>`).join('')}</select></div></div><div class="form-group"><label class="form-label">Mitigasi</label><textarea class="form-textarea" id="er-mit">${r.mitigation}</textarea></div><div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" style="flex:1" onclick="saveRiskEdit('${id}')"><i class="fa fa-save"></i> Simpan</button><button class="btn" onclick="closeModalDirect()">Batal</button></div>`;openModalDirect();}
function saveRiskEdit(id){const r=DB.risks.find(x=>x.id===id);if(!r)return;r.desc=document.getElementById('er-desc').value||r.desc;r.cat=document.getElementById('er-cat').value;r.status=document.getElementById('er-status').value;r.likelihood=parseInt(document.getElementById('er-like').value);r.impact=parseInt(document.getElementById('er-impact').value);r.mitigation=document.getElementById('er-mit').value;scheduleSave();closeModalDirect();renderRisk();}
function deleteRisk(id){if(!confirm('Hapus?'))return;DB.risks=DB.risks.filter(x=>x.id!==id);scheduleSave();renderRisk();}

// ═══════════════ PROCUREMENT ═══════════════

// ═══ EWS PENGADAAN ═══
let procActiveTab = 'daftar';

function analyzePO(po){
  const now=Date.now();
  const startMs=po.date?new Date(po.date).getTime():now;
  const dueMs=po.due?new Date(po.due).getTime():null;
  const dl=daysLeft(po.due);
  const rt=(po.tasks||[]).filter(t=>!t.isSection);
  const tw=rt.reduce((s,t)=>s+(t.weight||0),0);
  const dw=rt.reduce((s,t)=>s+(t.done?(t.weight||0):0),0);
  const prog=tw>0?Math.round(dw/tw*100):0;
  let timePct=0;
  if(dueMs&&startMs){const tot=dueMs-startMs;if(tot>0)timePct=Math.min(Math.round(((now-startMs)/tot)*100),100);}
  const gap=timePct-prog;
  const agingDays=Math.round((now-startMs)/86400000);
  const budget=po.budget||po.value||0;
  const spentPct=budget>0?Math.round((po.spent||0)/budget*100):0;
  const isStagnant=prog===0&&agingDays>5;
  const pendingTasks=rt.filter(t=>!t.done);
  const doneTasks=rt.filter(t=>t.done);
  const currentTask=pendingTasks[0]||null;
  const isPlanning=prog<20,isLelang=prog>=20&&prog<50,isKontrak=prog>=50&&prog<55,isImplement=prog>=55&&prog<95;
  const currentPhase=isPlanning?'Planning':isLelang?'Proses Lelang':isKontrak?'Kontrak':isImplement?'Implementation':'Compliance/Result';
  let estDelay=0;
  if(dl!==null&&gap>20&&dueMs){const rate=prog>0?prog/agingDays:0.5;const needDays=rate>0?(100-prog)/rate:(dl/24)+30;estDelay=Math.max(0,Math.round(needDays-dl/24));}
  const causes=[];
  if(gap>30) causes.push('Progress tertinggal '+gap+'% dari rencana waktu');
  if(isStagnant) causes.push('Tidak ada aktivitas selama '+agingDays+' hari');
  if(spentPct>=70&&prog<50) causes.push('Anggaran terpakai '+spentPct+'%, progres hanya '+prog+'%');
  if(dl!==null&&dl<0) causes.push('Melewati due date '+Math.abs(Math.round(dl/24))+' hari');
  const recs=[];
  if(isStagnant) recs.push('Eskalasi ke manajemen — tidak ada progres 5+ hari');
  if(gap>30) recs.push('Percepat tahapan '+currentPhase+' — tertinggal '+gap+'%');
  if(dl!==null&&dl<=336&&prog<60) recs.push('Lakukan daily monitoring dan weekly report');
  if(spentPct>=90) recs.push('Audit penggunaan anggaran segera');
  if(!recs.length) recs.push('Pertahankan ritme pekerjaan saat ini');
  if(po.status==='Delivered'||po.status==='Cancelled') return null;
  let status,color,icon;
  if(dl!==null&&dl<0){status='Risiko Gagal Due Date';color='#d32f2f';icon='fa-circle-exclamation';}
  else if(gap>=40||(timePct>=90&&prog<50)||(isStagnant&&dl!==null&&dl<=168)){status='Risiko Gagal Due Date';color='#d32f2f';icon='fa-circle-exclamation';}
  else if(gap>=25||(dl!==null&&dl<=168&&prog<50)||(timePct>=70&&gap>=20)){status='Warning Keterlambatan';color='#ef6c00';icon='fa-triangle-exclamation';}
  else if(gap>=15||(dl!==null&&dl<=336&&prog<50)||isStagnant){status='Potensi Delay';color='#f9a825';icon='fa-exclamation-circle';}
  else{status='On Track';color='#2e7d32';icon='fa-circle-check';}
  const riskPct=dl!==null&&dl<0?95:Math.min(Math.max(gap>0?gap+20:10,10),95);
  return{status,color,icon,riskPct,prog,timePct,gap,agingDays,estDelay,currentPhase,currentTask,causes,recs,spentPct,isStagnant,dl};
}

function getPOEWS(po){
  const a=analyzePO(po);if(!a||a.status==='On Track') return null;
  const em={'Risiko Gagal Due Date':'🔴','Warning Keterlambatan':'🟠','Potensi Delay':'🟡'};
  return{level:(em[a.status]||'')+' '+a.status,color:a.color,icon:a.icon,reason:a.causes[0]||'Perlu monitoring',riskPct:a.riskPct,analysis:a};
}

function renderProcEWSTab(){
  const el=document.getElementById('proc-tab-content'); if(!el) return;
  const ewsPOs=DB.procurement.map(po=>({po,ews:getPOEWS(po)})).filter(x=>x.ews!==null);
  const ewsHigh=ewsPOs.filter(x=>x.ews.color==='#d32f2f').length;
  const ewsMid=ewsPOs.filter(x=>x.ews.color==='#ef6c00').length;
  if(!ewsPOs.length){
    el.innerHTML='<div style="text-align:center;padding:60px;color:var(--t3)"><i class="fa fa-circle-check" style="font-size:48px;color:var(--success);display:block;margin-bottom:16px"></i><div style="font-size:15px;font-weight:600;color:var(--success)">Semua PO On Track</div><div style="font-size:12px;margin-top:6px">Tidak ada paket yang terdeteksi berisiko.</div></div>';
    return;
  }
  el.innerHTML=`<div style="background:var(--bg2);border:1px solid ${ewsHigh>0?'rgba(211,47,47,.4)':'rgba(239,108,0,.3)'};border-radius:10px;padding:14px 16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div>
        <div style="font-size:13px;font-weight:700;color:${ewsHigh>0?'#ff6b6b':'var(--warn)'}"><i class="fa fa-radar"></i> &nbsp;EWS PEKERJAAN PENGADAAN</div>
        <div style="font-size:10px;color:var(--t3);margin-top:2px">${ewsPOs.length} paket terdeteksi berisiko — klik <i class="fa fa-magnifying-glass"></i> untuk detail, klik area keterangan untuk tambah catatan</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${ewsPOs.filter(x=>x.ews.color==='#d32f2f').length?`<span style="background:#d32f2f20;color:#ff6b6b;border:1px solid #d32f2f40;padding:3px 10px;border-radius:8px;font-size:10px;font-weight:700">🔴 Risiko: ${ewsPOs.filter(x=>x.ews.color==='#d32f2f').length}</span>`:''}
        ${ewsPOs.filter(x=>x.ews.color==='#ef6c00').length?`<span style="background:#ef6c0020;color:#ffaa00;border:1px solid #ef6c0040;padding:3px 10px;border-radius:8px;font-size:10px;font-weight:700">🟠 Warning: ${ewsPOs.filter(x=>x.ews.color==='#ef6c00').length}</span>`:''}
        ${ewsPOs.filter(x=>x.ews.color==='#f9a825').length?`<span style="background:#f9a82520;color:#f9a825;border:1px solid #f9a82540;padding:3px 10px;border-radius:8px;font-size:10px;font-weight:700">🟡 Potensi: ${ewsPOs.filter(x=>x.ews.color==='#f9a825').length}</span>`:''}
      </div>
    </div>
    <div style="overflow-x:auto;margin-bottom:12px">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead><tr style="background:rgba(255,255,255,.04)">
          <th style="padding:6px 10px;text-align:left;color:var(--t3);font-size:9px">PAKET PEKERJAAN</th>
          <th style="padding:6px 8px;text-align:center;color:var(--t3);font-size:9px">STATUS EWS</th>
          <th style="padding:6px 8px;text-align:center;color:var(--t3);font-size:9px;white-space:nowrap">RISIKO</th>
          <th style="padding:6px 8px;text-align:center;color:var(--t3);font-size:9px">PROGRES</th>
          <th style="padding:6px 8px;text-align:center;color:var(--t3);font-size:9px;white-space:nowrap">WAKTU %</th>
          <th style="padding:6px 8px;text-align:center;color:var(--t3);font-size:9px">GAP</th>
          <th style="padding:6px 8px;text-align:left;color:var(--t3);font-size:9px">TAHAPAN</th>
          <th style="padding:6px 8px;text-align:center;color:var(--t3);font-size:9px;white-space:nowrap">EST.DELAY</th>
          <th style="padding:6px 8px;text-align:left;color:var(--t3);font-size:9px;min-width:160px">KETERANGAN</th>
          <th style="padding:6px 4px;color:var(--t3);font-size:9px"></th>
        </tr></thead>
        <tbody>
          ${ewsPOs.sort((a,b)=>b.ews.riskPct-a.ews.riskPct).map(({po,ews})=>{
            const a=ews.analysis||{};
            const ket=po.ewsKeterangan||'';
            return `<tr style="border-bottom:1px solid var(--border)${a.isStagnant?';background:rgba(255,59,59,.03)':''}">
              <td style="padding:8px 10px">
                <div style="font-weight:600;font-size:11px;white-space:normal;word-break:break-word;min-width:160px;max-width:220px">${po.item}</div>
                <div style="font-size:9px;color:var(--t3)">${unitName(po.unitId)} · <span style="color:${po.jenis==='Capex'?'var(--accent)':'var(--purple)'}">${po.jenis||'—'}</span> · Rp ${po.value||0}Jt</div>
              </td>
              <td style="padding:8px;text-align:center">
                <span style="background:${ews.color}18;color:${ews.color};border:1px solid ${ews.color}40;padding:2px 6px;border-radius:5px;font-size:9px;font-weight:700;white-space:nowrap">${ews.level}</span>
              </td>
              <td style="padding:8px;text-align:center">
                <div style="display:flex;align-items:center;gap:3px;justify-content:center">
                  <div style="width:32px;height:4px;background:rgba(255,255,255,.1);border-radius:2px;overflow:hidden"><div style="height:100%;width:${ews.riskPct}%;background:${ews.color}"></div></div>
                  <span style="font-size:10px;font-weight:700;color:${ews.color}">${ews.riskPct}%</span>
                </div>
              </td>
              <td style="padding:8px;text-align:center"><span style="font-size:12px;font-weight:700;color:${progColor(a.prog||0)}">${a.prog||0}%</span></td>
              <td style="padding:8px;text-align:center"><span style="font-size:12px;font-weight:700;color:${(a.timePct||0)>=80?'var(--warn)':'var(--t2)'}">${a.timePct||0}%</span></td>
              <td style="padding:8px;text-align:center">
                <span style="font-size:12px;font-weight:700;color:${(a.gap||0)>20?'var(--danger)':(a.gap||0)>10?'var(--warn)':'var(--success)'}">${(a.gap||0)>0?'+':''}${a.gap||0}%</span>
              </td>
              <td style="padding:8px">
                <div style="font-size:10px;color:var(--t2)">${a.currentPhase||'—'}</div>
                ${a.currentTask?`<div style="font-size:9px;color:var(--t3);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">→ ${a.currentTask.text}</div>`:''}
                ${a.isStagnant?`<div style="font-size:9px;color:var(--danger);font-weight:600">⚠ STAGNAN</div>`:''}
              </td>
              <td style="padding:8px;text-align:center">
                ${(a.estDelay||0)>0?`<span style="color:var(--danger);font-weight:700">+${a.estDelay}h</span>`:`<span style="color:var(--t3)">—</span>`}
              </td>
              <td style="padding:8px;min-width:160px">
                <div id="ewsket-${po.id}" onclick="editEWSKet('${po.id}')" style="font-size:10px;color:var(--t2);cursor:pointer;padding:5px 7px;border:1px dashed ${ket?'var(--accent)':'rgba(255,255,255,.15)'};border-radius:5px;min-height:30px;background:${ket?'rgba(26,140,255,.06)':'transparent'}" title="Klik untuk tambah/edit keterangan">
                  ${ket?`<i class="fa fa-note-sticky" style="color:var(--accent);margin-right:4px"></i>${ket}`:`<span style="color:var(--t3);font-style:italic">+ Tambah keterangan...</span>`}
                </div>
              </td>
              <td style="padding:8px;text-align:center">
                <button class="btn btn-sm" onclick="showPOAnalysis('${po.id}')" style="padding:2px 7px;font-size:9px"><i class="fa fa-magnifying-glass"></i></button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="background:rgba(26,140,255,.06);border:1px solid rgba(26,140,255,.2);border-radius:8px;padding:10px 12px">
      <div style="font-size:10px;font-weight:700;color:var(--accent);margin-bottom:8px"><i class="fa fa-bolt"></i> REKOMENDASI PERCEPATAN</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px">
        ${(()=>{const m=new Map();ewsPOs.forEach(({ews})=>(ews.analysis?.recs||[]).forEach(r=>{if(!m.has(r))m.set(r,{r,count:0,pct:0});m.get(r).count++;m.get(r).pct=Math.max(m.get(r).pct,ews.riskPct);}));return[...m.values()].sort((a,b)=>b.pct-a.pct).slice(0,6).map(({r,count})=>`<div style="display:flex;align-items:flex-start;gap:5px;padding:5px 8px;background:var(--bg3);border-radius:5px"><i class="fa fa-arrow-right" style="color:var(--accent);font-size:9px;flex-shrink:0;margin-top:2px"></i><span style="font-size:10px">${r}</span>${count>1?`<span style="margin-left:auto;font-size:9px;color:var(--t3)">${count} PO</span>`:''}</div>`).join('');})()}
      </div>
    </div>
  </div>`;
}

function editEWSKet(poId){
  const po=DB.procurement.find(x=>x.id===poId); if(!po) return;
  const el=document.getElementById('ewsket-'+poId); if(!el) return;
  const cur=po.ewsKeterangan||'';
  el.innerHTML=`<textarea id="ewsinp-${poId}" rows="2" style="width:100%;background:var(--bg3);border:1px solid var(--accent);color:var(--t1);padding:4px 6px;border-radius:4px;font-size:10px;font-family:inherit;resize:vertical;box-sizing:border-box">${cur}</textarea><div style="display:flex;gap:4px;margin-top:4px"><button class="btn btn-sm btn-primary" onclick="saveEWSKet('${poId}')" style="font-size:9px;flex:1"><i class="fa fa-check"></i> Simpan</button><button class="btn btn-sm" onclick="renderProcEWSTab()" style="font-size:9px"><i class="fa fa-xmark"></i></button></div>`;
  el.onclick=null;
  setTimeout(()=>{const t=document.getElementById('ewsinp-'+poId);if(t){t.focus();t.setSelectionRange(t.value.length,t.value.length);}},50);
}

function saveEWSKet(poId){
  const po=DB.procurement.find(x=>x.id===poId); if(!po) return;
  const inp=document.getElementById('ewsinp-'+poId); if(!inp) return;
  po.ewsKeterangan=inp.value.trim();
  scheduleSave();
  renderProcEWSTab();
}

function showPOAnalysis(poId){
  const po=DB.procurement.find(x=>x.id===poId);if(!po)return;
  const a=analyzePO(po);
  if(!a){alert('PO ini sudah Delivered atau Cancelled.');return;}
  document.getElementById('modal-title').innerHTML='<i class="fa fa-radar" style="color:var(--accent)"></i> Analisis EWS — '+po.item;
  document.getElementById('modal-body').innerHTML=`
    <div style="background:${a.color}10;border:1px solid ${a.color}40;border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="background:${a.color};color:${a.color==='#f9a825'?'#333':'#fff'};padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700">${a.status}</span>
      <span style="font-size:24px;font-weight:900;color:${a.color}">${a.riskPct}%</span>
      <span style="font-size:11px;color:var(--t3)">risiko keterlambatan</span>
      ${a.estDelay>0?`<span style="margin-left:auto;color:var(--danger);font-size:11px;font-weight:600"><i class="fa fa-clock"></i> Est. Delay: +${a.estDelay} hari</span>`:''}
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">
      ${[['Progres Aktual',a.prog+'%',progColor(a.prog)],['Rencana (Waktu)',a.timePct+'%','var(--t2)'],
         ['Gap Progres',(a.gap>0?'+':'')+a.gap+'%',a.gap>20?'var(--danger)':a.gap>10?'var(--warn)':'var(--success)'],
         ['Waktu Terpakai',a.timePct+'%',a.timePct>80?'var(--warn)':'var(--t2)'],
         ['Aging (hari)',a.agingDays+' hari','var(--t2)'],
         ['Anggaran',a.spentPct+'%',a.spentPct>=90?'var(--danger)':a.spentPct>=70?'var(--warn)':'var(--success)']
        ].map(([l,v,cl])=>`<div style="background:var(--bg3);border-radius:7px;padding:8px 10px"><div style="font-size:9px;color:var(--t3);margin-bottom:3px">${l}</div><div style="font-size:16px;font-weight:800;color:${cl}">${v}</div></div>`).join('')}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      <div>
        <div style="font-size:10px;font-weight:700;color:var(--t3);margin-bottom:6px"><i class="fa fa-location-dot" style="color:var(--accent)"></i> Tahapan Aktif</div>
        <div style="background:var(--bg3);border-radius:7px;padding:8px 10px">
          <div style="font-weight:600;font-size:11px">${a.currentPhase}</div>
          ${a.currentTask?`<div style="color:var(--t3);font-size:10px;margin-top:3px">→ ${a.currentTask.text}</div>`:'<div style="color:var(--success);font-size:10px">Semua task selesai</div>'}
          ${a.isStagnant?`<div style="color:var(--danger);font-size:9px;font-weight:600;margin-top:4px">⚠ STAGNAN ${a.agingDays} hari</div>`:''}
        </div>
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;color:var(--t3);margin-bottom:6px"><i class="fa fa-magnifying-glass" style="color:var(--danger)"></i> Penyebab Utama</div>
        <div style="background:var(--bg3);border-radius:7px;padding:8px 10px">
          ${a.causes.length?a.causes.map((cause,i)=>`<div style="display:flex;gap:6px;margin-bottom:3px"><span style="background:var(--danger);color:#fff;font-size:8px;font-weight:700;width:15px;height:15px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">${i+1}</span><span style="font-size:10px">${cause}</span></div>`).join(''):'<span style="font-size:10px;color:var(--t3)">Tidak teridentifikasi</span>'}
        </div>
      </div>
    </div>
    <div style="background:rgba(26,140,255,.06);border:1px solid rgba(26,140,255,.2);border-radius:8px;padding:10px 12px;margin-bottom:12px">
      <div style="font-size:10px;font-weight:700;color:var(--accent);margin-bottom:6px"><i class="fa fa-bolt"></i> Rekomendasi Percepatan</div>
      ${a.recs.map(r=>`<div style="display:flex;gap:6px;margin-bottom:4px"><i class="fa fa-arrow-right" style="color:var(--accent);font-size:9px;flex-shrink:0;margin-top:2px"></i><span style="font-size:10px">${r}</span></div>`).join('')}
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" style="flex:1" onclick="editPO('${poId}');closeModalDirect()"><i class="fa fa-pen"></i> Edit PO</button>
      <button class="btn" onclick="closeModalDirect()">Tutup</button>
    </div>`;
  openModalDirect();
}

function poCard(po){
  const dl=daysLeft(po.due);
  const jc=po.jenis==='Capex'?'var(--accent)':po.jenis==='Opex'?'var(--purple)':'var(--t3)';
  const jb=po.jenis==='Capex'?'rgba(26,140,255,.12)':po.jenis==='Opex'?'rgba(168,85,247,.12)':'var(--bg3)';
  const div=(()=>{const u=DB.units.find(x=>x.id===po.unitId);return u?u.divisi:'—';})();
  const realTasks=(po.tasks||[]).filter(t=>!t.isSection);
  const tw=realTasks.reduce((s,t)=>s+(t.weight||0),0);
  const dw=realTasks.reduce((s,t)=>s+(t.done?(t.weight||0):0),0);
  const prog=tw>0?Math.round(dw/tw*100):0;
  const isOpen=window._poOpen&&window._poOpen[po.id];
  return `<div style="background:var(--bg3);border-radius:8px;margin-bottom:8px;border:1px solid var(--border);border-left:3px solid ${jc};overflow:hidden">
    <!-- ── HEADER ── -->
    <div onclick="togglePoCard('${po.id}')" style="display:flex;align-items:center;gap:10px;padding:11px 14px;cursor:pointer;user-select:none"
      onmouseover="this.style.background='rgba(255,255,255,.03)'" onmouseout="this.style.background=''">
      <i class="fa fa-chevron-${isOpen?'down':'right'}" style="font-size:10px;color:var(--t3);flex-shrink:0"></i>
      <span style="background:${jb};color:${jc};border:1px solid ${jc}40;padding:2px 8px;border-radius:10px;font-size:9px;font-weight:700;flex-shrink:0">${po.jenis||'—'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${po.item}</div>
        <div style="font-size:10px;color:var(--t3);margin-top:1px">
          <i class="fa fa-truck"></i> ${po.vendor} &nbsp;·&nbsp;
          <i class="fa fa-building"></i> ${unitName(po.unitId)}
          ${dl<0?`&nbsp;·&nbsp;<span style="color:var(--danger);font-weight:600"><i class="fa fa-circle-exclamation"></i> OVERDUE</span>`:dl===0?'&nbsp;·&nbsp;<span style="color:var(--warn)">⚠ Hari ini</span>':dl<=7?`&nbsp;·&nbsp;<span style="color:var(--warn)">Sisa ${dl}h</span>`:''}
        </div>
      </div>
      <div style="flex-shrink:0;display:flex;align-items:center;gap:8px;min-width:140px">
        <div style="flex:1">
          <div class="prog-bar-wrap" style="height:6px"><div class="prog-bar" style="width:${prog}%;background:${progColor(prog)}"></div></div>
        </div>
        <span style="font-size:12px;font-weight:700;color:${progColor(prog)};min-width:36px;text-align:right">${prog}%</span>
      </div>
      <span class="badge ${po.status==='Delivered'?'badge-green':po.delay>0?'badge-red':'badge-yellow'}" style="font-size:9px;flex-shrink:0">${po.status}</span>
    </div>
    <!-- ── DETAIL ── -->
    <div id="podetail-${po.id}" style="display:${isOpen?'block':'none'};padding:0 14px 14px;border-top:1px solid var(--border)">
      <div style="font-size:10px;color:var(--t3);margin:10px 0 8px;display:flex;gap:16px;flex-wrap:wrap">
        <span><strong style="color:${jc}">Rp ${po.value}Jt</strong></span>
        <span><i class="fa fa-sitemap"></i> ${div}</span>
        <span>Due: <span style="color:${dl<0?'var(--danger)':dl<=7?'var(--warn)':'var(--t3)'}">${fmtDate(po.due)}</span></span>
        ${po.delay>0?`<span style="color:var(--danger)"><i class="fa fa-circle-exclamation"></i> Delay ${po.delay}h</span>`:''}
      </div>
      <div id="taskblock-${po.id}">${buildTasksHTML(po.tasks,po.id,'procurement')}</div>
      ${po.note?`<div style="margin-top:10px;padding:8px 12px;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.15);border-radius:6px;font-size:11px"><i class="fa fa-note-sticky" style="color:var(--warn)"></i> ${po.note}</div>`:''}
      <div style="display:flex;gap:5px;margin-top:10px;align-items:center">
        <button class="btn btn-sm" onclick="editPO('${po.id}');event.stopPropagation()"><i class="fa fa-pen"></i></button>
        <button class="btn btn-sm btn-danger" onclick="deletePO('${po.id}');event.stopPropagation()"><i class="fa fa-trash"></i></button>
        <div style="margin-left:auto;display:flex;flex-direction:column;gap:2px">
          <button class="btn btn-sm" onclick="moveItem('procurement','${po.id}',-1);event.stopPropagation()" style="padding:1px 6px;line-height:1"><i class="fa fa-chevron-up" style="font-size:9px"></i></button>
          <button class="btn btn-sm" onclick="moveItem('procurement','${po.id}',1);event.stopPropagation()" style="padding:1px 6px;line-height:1"><i class="fa fa-chevron-down" style="font-size:9px"></i></button>
        </div>
      </div>
    </div>
  </div>`;
}

let procFilter={jenis:'semua',groupBy:'none',tahun:'semua',bulan:'semua',unit:'semua',divisi:'semua'};

function renderProcurement(){
  const cont=document.getElementById('content');
  const capex=DB.procurement.filter(p=>p.jenis==='Capex');
  const opex=DB.procurement.filter(p=>p.jenis==='Opex');
  const totalCapex=capex.reduce((s,p)=>s+p.value,0);
  const totalOpex=opex.reduce((s,p)=>s+p.value,0);
  const mn=['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const years=[...new Set(DB.procurement.map(p=>p.date?p.date.substring(0,4):'').filter(Boolean))].sort().reverse();

  // Apply filters
  let filtered=DB.procurement.filter(p=>{
    if(procFilter.jenis!=='semua'&&p.jenis!==procFilter.jenis) return false;
    if(procFilter.unit!=='semua'&&p.unitId!==procFilter.unit) return false;
    if(procFilter.divisi!=='semua'){const u=DB.units.find(x=>x.id===p.unitId);if(!u||u.divisi!==procFilter.divisi) return false;}
    if(procFilter.tahun!=='semua'&&(!p.date||!p.date.startsWith(procFilter.tahun))) return false;
    if(procFilter.bulan!=='semua'&&(!p.date||p.date.substring(5,7)!==procFilter.bulan)) return false;
    return true;
  });

  // Grouping
  function groupItems(items,by){
    if(by==='none') return {'__all__':items};
    const g={};
    items.forEach(p=>{
      let key;
      if(by==='jenis') key=p.jenis||'—';
      else if(by==='unit') key=unitName(p.unitId);
      else if(by==='divisi'){const u=DB.units.find(x=>x.id===p.unitId);key=u?u.divisi:'—';}
      else if(by==='tahun') key=p.date?p.date.substring(0,4):'—';
      else if(by==='bulan') key=p.date?mn[parseInt(p.date.substring(5,7))-1]+' '+p.date.substring(0,4):'—';
      if(!g[key])g[key]=[];g[key].push(p);
    });
    return Object.fromEntries(Object.entries(g).sort((a,b)=>a[0].localeCompare(b[0])));
  }
  const grouped=groupItems(filtered,procFilter.groupBy);
  const showGrpHdr=procFilter.groupBy!=='none';
  const hasFilter=procFilter.jenis!=='semua'||procFilter.unit!=='semua'||procFilter.divisi!=='semua'||procFilter.tahun!=='semua'||procFilter.bulan!=='semua'||procFilter.groupBy!=='none';
  const filtUnits=procFilter.divisi==='semua'?DB.units:DB.units.filter(u=>u.divisi===procFilter.divisi);


  const ewsPOs2=DB.procurement.map(po=>({po,ews:getPOEWS(po)})).filter(x=>x.ews!==null);
  const ewsH=ewsPOs2.filter(x=>x.ews.color==='#d32f2f').length;
  const ewsM=ewsPOs2.filter(x=>x.ews.color==='#ef6c00').length;

  cont.innerHTML=`
  <div class="stat-row">
    <div class="stat-box"><div class="sl">Total PO</div><div class="sv">${DB.procurement.length}</div><div class="sv-sub">Rp ${(totalCapex+totalOpex).toFixed(0)}Jt</div></div>
    <div class="stat-box" style="border-left:3px solid var(--accent)"><div class="sl">Capex</div><div class="sv" style="color:var(--accent)">${capex.length}</div><div class="sv-sub">Rp ${totalCapex.toFixed(0)}Jt</div></div>
    <div class="stat-box" style="border-left:3px solid var(--purple)"><div class="sl">Opex</div><div class="sv" style="color:var(--purple)">${opex.length}</div><div class="sv-sub">Rp ${totalOpex.toFixed(0)}Jt</div></div>
    <div class="stat-box"><div class="sl">In Progress</div><div class="sv" style="color:var(--warn)">${DB.procurement.filter(p=>p.status!=='Delivered'&&p.status!=='Cancelled').length}</div></div>
    <div class="stat-box" style="border-left:3px solid var(--danger);cursor:pointer" onclick="procActiveTab='ews';renderProcurement()">
      <div class="sl">EWS Alert</div>
      <div class="sv" style="color:${ewsH>0?'var(--danger)':ewsM>0?'var(--warn)':'var(--success)'}">${ewsPOs2.length}</div>
      <div class="sv-sub">${ewsH} high · ${ewsM} mod</div>
    </div>
    <div class="stat-box"><div class="sl">Selesai</div><div class="sv" style="color:var(--success)">${DB.procurement.filter(p=>p.status==='Delivered').length}</div></div>
  </div>
  <div class="tabs" style="margin-bottom:12px">
    <button class="tab ${procActiveTab==='daftar'?'active':''}" onclick="procActiveTab='daftar';renderProcurement()"><i class="fa fa-list"></i> Daftar PO</button>
    <button class="tab ${procActiveTab==='ews'?'active':''}" onclick="procActiveTab='ews';renderProcurement()" style="position:relative">
      <i class="fa fa-radar"></i> EWS Pekerjaan
      ${ewsPOs2.length>0?`<span style="position:absolute;top:-4px;right:-4px;background:${ewsH>0?'var(--danger)':'var(--warn)'};color:#fff;font-size:8px;font-weight:700;padding:1px 5px;border-radius:8px">${ewsPOs2.length}</span>`:''}
    </button>
  </div>
  <div id="proc-tab-content"></div>`;
  if(procActiveTab==='ews'){ renderProcEWSTab(); return; }

  // Tab Daftar PO: inject ke proc-tab-content
  const tabEl=document.getElementById('proc-tab-content'); if(!tabEl) return;
  tabEl.innerHTML=`
  <!-- FILTER PANEL -->
  <div class="panel" style="padding:10px 14px;margin-bottom:4px">
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px">
      <span style="font-size:10px;font-weight:700;color:var(--t3)"><i class="fa fa-filter"></i> FILTER:</span>
      <!-- Jenis -->
      <select class="form-select" style="padding:4px 8px;font-size:11px;width:auto" onchange="procFilter.jenis=this.value;renderProcurement()">
        <option value="semua"${procFilter.jenis==='semua'?' selected':''}>Semua Jenis</option>
        <option value="Capex"${procFilter.jenis==='Capex'?' selected':''}>Capex</option>
        <option value="Opex"${procFilter.jenis==='Opex'?' selected':''}>Opex</option>
      </select>
      <!-- Divisi -->
      <select class="form-select" style="padding:4px 8px;font-size:11px;width:auto" onchange="procFilter.divisi=this.value;procFilter.unit='semua';renderProcurement()">
        <option value="semua">Semua Divisi</option>
        ${DB.divisions.map(d=>`<option value="${d}"${procFilter.divisi===d?' selected':''}>${d}</option>`).join('')}
      </select>
      <!-- Unit -->
      <select class="form-select" style="padding:4px 8px;font-size:11px;width:auto" onchange="procFilter.unit=this.value;renderProcurement()">
        <option value="semua">Semua Unit</option>
        ${filtUnits.map(u=>`<option value="${u.id}"${procFilter.unit===u.id?' selected':''}>${u.name}</option>`).join('')}
      </select>
      <!-- Tahun -->
      <select class="form-select" style="padding:4px 8px;font-size:11px;width:auto" onchange="procFilter.tahun=this.value;renderProcurement()">
        <option value="semua">Semua Tahun</option>
        ${years.map(y=>`<option value="${y}"${procFilter.tahun===y?' selected':''}>${y}</option>`).join('')}
      </select>
      <!-- Bulan -->
      <select class="form-select" style="padding:4px 8px;font-size:11px;width:auto" onchange="procFilter.bulan=this.value;renderProcurement()">
        <option value="semua">Semua Bulan</option>
        ${['01','02','03','04','05','06','07','08','09','10','11','12'].map((m,i)=>`<option value="${m}"${procFilter.bulan===m?' selected':''}>${mn[i]}</option>`).join('')}
      </select>
      <div style="margin-left:auto;display:flex;align-items:center;gap:6px">
        <span style="font-size:10px;font-weight:700;color:var(--t3)"><i class="fa fa-layer-group"></i> KELOMPOKKAN:</span>
        <select class="form-select" style="padding:4px 8px;font-size:11px;width:auto" onchange="procFilter.groupBy=this.value;renderProcurement()">
          <option value="none"${procFilter.groupBy==='none'?' selected':''}>— Tidak dikelompokkan</option>
          <option value="jenis"${procFilter.groupBy==='jenis'?' selected':''}>Jenis (Capex/Opex)</option>
          <option value="divisi"${procFilter.groupBy==='divisi'?' selected':''}>Divisi</option>
          <option value="unit"${procFilter.groupBy==='unit'?' selected':''}>Unit</option>
          <option value="tahun"${procFilter.groupBy==='tahun'?' selected':''}>Tahun</option>
          <option value="bulan"${procFilter.groupBy==='bulan'?' selected':''}>Bulan</option>
        </select>
        ${hasFilter?`<button class="btn btn-sm btn-danger" onclick="procFilter={jenis:'semua',groupBy:'none',tahun:'semua',bulan:'semua',unit:'semua',divisi:'semua'};renderProcurement()"><i class="fa fa-rotate-left"></i> Reset</button>`:''}
      </div>
    </div>
    ${filtered.length!==DB.procurement.length?`<div style="margin-top:6px;padding:5px 10px;background:rgba(26,140,255,.08);border-radius:6px;font-size:11px;color:var(--accent)"><i class="fa fa-filter"></i> Menampilkan <strong>${filtered.length}</strong> dari ${DB.procurement.length} PO · Rp ${filtered.reduce((s,p)=>s+p.value,0).toFixed(0)}Jt</div>`:''}
  </div>

  ${filtered.length===0?`<div class="panel" style="text-align:center;color:var(--t3);padding:40px"><i class="fa fa-search" style="font-size:24px;margin-bottom:10px;display:block"></i>Tidak ada data yang sesuai filter.</div>`:
    Object.entries(grouped).map(([gn,items])=>{
      const gTotal=items.reduce((s,p)=>s+p.value,0);
      const gCapex=items.filter(p=>p.jenis==='Capex').length;
      const gOpex=items.filter(p=>p.jenis==='Opex').length;
      return `${showGrpHdr?`<div style="display:flex;align-items:center;gap:8px;margin:14px 0 6px;padding-left:10px;border-left:3px solid var(--accent)">
        <div style="font-size:13px;font-weight:700;color:var(--t1)">${gn}</div>
        <span class="badge badge-blue">${items.length} PO</span>
        ${gCapex?`<span style="font-size:10px;color:var(--accent)">Capex: ${gCapex}</span>`:''}
        ${gOpex?`<span style="font-size:10px;color:var(--purple)">Opex: ${gOpex}</span>`:''}
        <span style="margin-left:auto;font-size:11px;color:var(--t2)">Rp ${gTotal.toFixed(0)}Jt</span>
      </div>`:''}
      ${items.map(poCard).join('')}`;
    }).join('')}`;
}

function openProcurementForm(){
  document.getElementById('modal-title').textContent='Tambah Purchase Order';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-group">
      <label class="form-label">Jenis Anggaran</label>
      <div style="display:flex;gap:8px;margin-bottom:4px">
        <div id="btn-capex" onclick="selectJenis('Capex')" style="flex:1;background:rgba(26,140,255,.12);border:2px solid var(--accent);border-radius:8px;padding:10px;text-align:center;cursor:pointer">
          <div style="font-size:13px;font-weight:700;color:var(--accent)">CAPEX</div>
          <div style="font-size:9px;color:var(--t3)">Capital Expenditure</div>
        </div>
        <div id="btn-opex" onclick="selectJenis('Opex')" style="flex:1;background:var(--bg3);border:2px solid var(--border2);border-radius:8px;padding:10px;text-align:center;cursor:pointer">
          <div id="opex-label" style="font-size:13px;font-weight:700;color:var(--t2)">OPEX</div>
          <div style="font-size:9px;color:var(--t3)">Operational Expenditure</div>
        </div>
      </div>
      <input type="hidden" id="po-jenis" value="Capex">
    </div>
    <div class="form-group"><label class="form-label">Nama Item/Jasa</label><input class="form-input" id="po-item" placeholder="e.g. Mechanical Seal"></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Vendor</label><input class="form-input" id="po-vendor" placeholder="Nama vendor"></div>
      <div class="form-group"><label class="form-label">Divisi</label>
        <select class="form-select" id="po-divisi" onchange="updatePOUnitDropdown()">
          <option value="">— Pilih Divisi —</option>
          ${DB.divisions.map(d=>`<option value="${d}">${d}</option>`).join('')}
        </select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Unit</label><select class="form-select" id="po-unit"><option value="">— Pilih Unit —</option>${DB.units.map(u=>`<option value="${u.id}">${u.name}</option>`).join('')}</select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Nilai (Rp Juta)</label><input class="form-input" type="number" id="po-value" placeholder="0"></div>
      <div class="form-group"><label class="form-label">Due Date</label><input class="form-input" type="date" id="po-due"></div>
    </div>
    <div class="form-group"><label class="form-label">Catatan Tindak Lanjut</label><textarea class="form-textarea" id="po-note" placeholder="Catatan..." rows="2"></textarea></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-primary" style="flex:1" onclick="saveNewPO()"><i class="fa fa-save"></i> Simpan</button>
      <button class="btn" onclick="closeModalDirect()">Batal</button>
    </div>`;
  openModalDirect();
}
function selectJenis(jenis){
  document.getElementById('po-jenis').value=jenis;
  const cb=document.getElementById('btn-capex'), ob=document.getElementById('btn-opex');
  if(jenis==='Capex'){
    cb.style.cssText='flex:1;background:rgba(26,140,255,.12);border:2px solid var(--accent);border-radius:8px;padding:10px;text-align:center;cursor:pointer';
    cb.querySelector('div').style.color='var(--accent)';
    ob.style.cssText='flex:1;background:var(--bg3);border:2px solid var(--border2);border-radius:8px;padding:10px;text-align:center;cursor:pointer';
    document.getElementById('opex-label').style.color='var(--t2)';
  } else {
    ob.style.cssText='flex:1;background:rgba(168,85,247,.12);border:2px solid var(--purple);border-radius:8px;padding:10px;text-align:center;cursor:pointer';
    document.getElementById('opex-label').style.color='var(--purple)';
    cb.style.cssText='flex:1;background:var(--bg3);border:2px solid var(--border2);border-radius:8px;padding:10px;text-align:center;cursor:pointer';
    cb.querySelector('div').style.color='var(--t2)';
  }
}
function updatePOUnitDropdown(){
  const divisi = document.getElementById('po-divisi')?.value||'';
  const unitSel = document.getElementById('po-unit');
  if(!unitSel) return;
  const units = divisi ? DB.units.filter(u=>u.divisi===divisi) : DB.units;
  unitSel.innerHTML = '<option value="">— Pilih Unit —</option>' + units.map(u=>`<option value="${u.id}">${u.name}</option>`).join('');
}

// ── Default task structure untuk Pengadaan ──
// Section header ditandai dengan isSection:true
function defaultProcurementTasks(){
  const s = (text, weight=0, section=false, indent=0) => ({
    id: uid(), text, done: false, weight, due: '', isSection: section, indent
  });
  return [
    // ── PLANNING (max 20%) ──
    s('PLANNING', 0, true),
    s('Penyusunan Dokumen', 3, false, 1),
    s('Persetujuan Dokumen', 3, false, 1),
    s('Cek Anggaran', 2, false, 1),
    s('Penyampaian Berkas ke Procurement', 2, false, 1),
    s('Proses Lelang', 0, true, 1),
    s('Pengumuman Lelang', 1, false, 2),
    s('Pendaftaran VMS', 1, false, 2),
    s('Undangan melalui VMS', 1, false, 2),
    s('Pendaftaran peserta lelang dan download dokumen pengadaan', 1, false, 2),
    s('Aanwijzing', 1, false, 2),
    s('Pemasukan dokumen penawaran', 1, false, 2),
    s('Pembukaan dokumen penawaran', 1, false, 2),
    s('Evaluasi dokumen penawaran (administrasi, teknis, dan harga)', 1, false, 2),
    s('Klarifikasi dan negosiasi', 1, false, 2),
    s('Penetapan urutan pemenang & pengumuman pemenang', 1, false, 2),
    s('Masa sanggah', 1, false, 2),
    s('Surat Pemberitahuan', 1, false, 2),
    s('Kontrak Pekerjaan', 1, false, 1),
    // ── IMPLEMENTATION (max 80%) ──
    s('IMPLEMENTATION', 0, true),
    s('Pelaksanaan Pekerjaan', 60, false, 1),
    s('Pemeliharaan', 20, false, 1),
    // ── IMPACT (≥ 100%) ──
    s('IMPACT ≥ 100%', 0, true),
    s('Result (100%)', 0, true, 1),
    s('Compliance', 0, false, 2),
  ];
}

function saveNewPO(){
  const item=document.getElementById('po-item').value.trim();
  if(!item){alert('Nama item wajib');return;}
  const id=uid();
  const unitId=document.getElementById('po-unit').value;
  const value=parseFloat(document.getElementById('po-value').value)||0;
  const due=document.getElementById('po-due').value;
  const jenis=document.getElementById('po-jenis').value||'Capex';
  const vendor=document.getElementById('po-vendor').value;
  const note=document.getElementById('po-note').value;
  const progId=uid();
  const tasksCopy=defaultProcurementTasks();
  const tasksCopy2=defaultProcurementTasks();
  const po={id,item,jenis,vendor,unitId,value,budget:value,spent:0,date:today(),due,delay:0,status:'In Progress',stage:'PR',note,tasks:tasksCopy,progId};
  const prog={id:progId,name:'[Pengadaan] '+item,unitId,pic:vendor||'—',start:today(),end:due||today(),budget:value,spent:0,useAsKPI:false,kpiTarget:100,kpiWeight:10,status:'In Progress',riskId:'',desc:'PO '+jenis+' vendor '+vendor+'. Nilai: Rp '+value+'Jt',progress:0,tasks:tasksCopy2,fromPO:id};
  DB.procurement.push(po);
  DB.programs.push(prog);
  syncKPIsFromPrograms();scheduleSave();closeModalDirect();renderProcurement();
  alert('PO disimpan dan otomatis dibuat di Program Kerja: "'+prog.name+'"');
}

function editPO(id){
  const po=DB.procurement.find(x=>x.id===id);if(!po)return;
  const budget=po.budget||po.value||0;
  const spent=po.spent||0;
  const pct=budget>0?Math.round(spent/budget*100):0;
  const pc=pct>=90?'var(--danger)':pct>=70?'var(--warn)':'var(--success)';
  const curUnit=DB.units.find(x=>x.id===po.unitId);
  const curDivisi=curUnit?curUnit.divisi:'';
  const filtUnits=curDivisi?DB.units.filter(u=>u.divisi===curDivisi):DB.units;
  document.getElementById('modal-title').textContent='Edit PO';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-row">
      <div class="form-group"><label class="form-label">Nama Item/Jasa</label>
        <input class="form-input" id="epo-item" value="${po.item||''}"></div>
      <div class="form-group"><label class="form-label">Vendor</label>
        <input class="form-input" id="epo-vendor" value="${po.vendor||''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Divisi</label>
        <select class="form-select" id="epo-divisi" onchange="updateEditPOUnits()">
          <option value="">— Semua Divisi —</option>
          ${DB.divisions.map(d=>`<option value="${d}"${d===curDivisi?' selected':''}>${d}</option>`).join('')}
        </select></div>
      <div class="form-group"><label class="form-label">Unit</label>
        <select class="form-select" id="epo-unit">
          ${filtUnits.map(u=>`<option value="${u.id}"${u.id===po.unitId?' selected':''}>${u.name}</option>`).join('')}
        </select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Jenis Anggaran</label>
        <select class="form-select" id="epo-jenis">
          <option${(po.jenis||'Capex')==='Capex'?' selected':''}>Capex</option>
          <option${po.jenis==='Opex'?' selected':''}>Opex</option>
        </select></div>
      <div class="form-group"><label class="form-label">Status</label>
        <select class="form-select" id="epo-status">${['In Progress','In Transit','Delivered','Cancelled'].map(s=>`<option${s===po.status?' selected':''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Nilai/Anggaran (Rp Juta)</label>
        <input class="form-input" type="number" id="epo-budget" value="${budget}" oninput="updateSpentPreview(document.getElementById('epo-spent').value,this.value)">
      </div>
      <div class="form-group">
        <label class="form-label">Anggaran Terpakai (Rp Juta)</label>
        <div style="display:flex;gap:6px;align-items:center">
          <input class="form-input" type="number" id="epo-spent" value="${spent}" oninput="updateSpentPreview(this.value,document.getElementById('epo-budget').value)" style="flex:1">
          <button class="btn btn-sm btn-danger" onclick="document.getElementById('epo-spent').value=0;updateSpentPreview(0,document.getElementById('epo-budget').value)" title="Reset"><i class="fa fa-rotate-left"></i></button>
        </div>
        <div id="spent-preview" style="font-size:10px;margin-top:4px;color:${pc};font-weight:600">${pct}% terpakai dari Rp ${budget}Jt</div>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Delay (hari)</label><input class="form-input" type="number" id="epo-delay" value="${po.delay||0}"></div>
      <div class="form-group"><label class="form-label">Due Date</label><input class="form-input" type="date" id="epo-due" value="${po.due||''}"></div>
    </div>
    <div class="form-group"><label class="form-label">Catatan Tindak Lanjut</label><textarea class="form-textarea" id="epo-note">${po.note||''}</textarea></div>
    ${po.progId?`<div style="background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:8px;padding:8px 12px;font-size:11px;color:var(--success);margin-bottom:6px">
      <i class="fa fa-link"></i> Tersinkronisasi dengan Program Kerja &nbsp;
      <label style="cursor:pointer"><input type="checkbox" id="epo-sync" checked style="margin-right:4px">Sinkron perubahan ke Program Kerja</label>
    </div>`:''}
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-primary" style="flex:1" onclick="savePOEdit('${id}')"><i class="fa fa-save"></i> Simpan</button>
      <button class="btn" onclick="closeModalDirect()">Batal</button>
    </div>`;
  openModalDirect();
}

function updateEditPOUnits(){
  const div=document.getElementById('epo-divisi')?.value||'';
  const sel=document.getElementById('epo-unit');if(!sel)return;
  const units=div?DB.units.filter(u=>u.divisi===div):DB.units;
  sel.innerHTML=units.map(u=>`<option value="${u.id}">${u.name}</option>`).join('');
}

function updateSpentPreview(spent,budget){
  const el=document.getElementById('spent-preview');if(!el)return;
  const s=parseFloat(spent)||0,b=parseFloat(budget)||0;
  const pct=b>0?Math.round(s/b*100):0;
  const color=pct>=90?'var(--danger)':pct>=70?'var(--warn)':'var(--success)';
  el.style.color=color;
  el.innerHTML=`<strong>${pct}%</strong> terpakai dari Rp ${b}Jt${pct>=90?' <i class="fa fa-triangle-exclamation"></i> Hampir habis!':''}`;
}

function savePOEdit(id){
  const po=DB.procurement.find(x=>x.id===id);if(!po)return;
  po.item=document.getElementById('epo-item').value||po.item;
  po.vendor=document.getElementById('epo-vendor').value;
  po.unitId=document.getElementById('epo-unit')?.value||po.unitId;
  po.jenis=document.getElementById('epo-jenis').value;
  po.status=document.getElementById('epo-status').value;
  po.budget=parseFloat(document.getElementById('epo-budget').value)||0;
  po.spent=parseFloat(document.getElementById('epo-spent').value)||0;
  po.value=po.budget;
  po.delay=parseInt(document.getElementById('epo-delay').value)||0;
  po.due=document.getElementById('epo-due').value;
  po.note=document.getElementById('epo-note').value;
  const syncChk=document.getElementById('epo-sync');
  if(po.progId&&(!syncChk||syncChk.checked)){
    syncPOToProgram(po.id);
    showToast('✅ Tersinkronisasi ke Program Kerja', 'var(--success)');
  }
  syncKPIsFromPrograms();scheduleSave();closeModalDirect();renderProcurement();
}

function deletePO(id){
  const po=DB.procurement.find(x=>x.id===id);if(!po)return;
  if(!confirm('Hapus PO "'+po.item+'"?'))return;
  if(po.progId&&DB.programs.find(x=>x.id===po.progId)){
    if(confirm('Hapus juga Program Kerja terkait?')){
      DB.programs=DB.programs.filter(x=>x.id!==po.progId);
    }
  }
  DB.procurement=DB.procurement.filter(x=>x.id!==id);
  syncKPIsFromPrograms();scheduleSave();renderProcurement();
}

// ═══════════════ ASSET & CMMS ═══════════════
function renderAsset(){
  const cont=document.getElementById('content');
  const at=cont.getAttribute('data-tab')||'asset';
  cont.setAttribute('data-tab',at);
  const {bar:aBar}=buildFilterBar('Asset',DB.assets,a=>a.purchaseDate||'',a=>a.unitId||'');
  cont.innerHTML=`${aBar}<div class="tabs"><button class="tab ${at==='asset'?'active':''}" onclick="setAssetTab('asset',this)">Asset Registry</button><button class="tab ${at==='cmms'?'active':''}" onclick="setAssetTab('cmms',this)">Maintenance CMMS</button><button class="tab ${at==='repair'?'active':''}" onclick="setAssetTab('repair',this)">Repair vs Replace</button></div><div id="asset-content"></div>`;
  renderAssetTab(at);
}
function setAssetTab(tab,btn){document.getElementById('content').setAttribute('data-tab',tab);document.querySelectorAll('.tabs .tab').forEach(b=>b.classList.remove('active'));btn.classList.add('active');renderAssetTab(tab);}
function renderAssetTab(tab){
  const el=document.getElementById('asset-content');
  if(tab==='asset'){
    el.innerHTML=`<div class="stat-row"><div class="stat-box"><div class="sl">Total Asset</div><div class="sv">${DB.assets.length}</div></div><div class="stat-box"><div class="sl">Cert Near Expiry</div><div class="sv" style="color:var(--warn)">${DB.assets.filter(a=>a.certStatus==='Near Expiry').length}</div></div><div class="stat-box"><div class="sl">Critical</div><div class="sv" style="color:var(--danger)">${DB.assets.filter(a=>a.crit==='Critical').length}</div></div><div class="stat-box"><div class="sl">Maint Due</div><div class="sv" style="color:var(--warn)">${DB.assets.filter(a=>a.schedMaint&&daysLeft(a.schedMaint)<=7).length}</div></div></div>
    ${DB.assets.map(a=>`<div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px">
        <div><div style="font-size:13px;font-weight:600">${a.name}</div><div style="font-size:10px;color:var(--t3);margin-top:2px"><span class="badge badge-blue">${a.code}</span> ${a.cat} · ${a.loc} · Tahun: ${a.year} · Rp ${a.value}Jt</div></div>
        <div style="display:flex;gap:5px;align-items:center;flex-shrink:0">
          <span class="badge ${a.crit==='Critical'?'badge-red':a.crit==='High'?'badge-yellow':'badge-blue'}">${a.crit}</span>
          <span class="badge ${a.certStatus==='Valid'?'badge-green':a.certStatus==='Near Expiry'?'badge-yellow':'badge-red'}">${a.certStatus}</span>
          <button class="btn btn-sm" onclick="editAsset('${a.id}')"><i class="fa fa-pen"></i></button>
        </div>
      </div>
      <div class="grid-3" style="margin-bottom:10px">
        <div style="background:var(--bg3);border-radius:6px;padding:8px"><div style="font-size:9px;color:var(--t3);margin-bottom:4px">Cert Expiry</div><div style="font-size:11px;color:${a.certStatus==='Expired'?'var(--danger)':a.certStatus==='Near Expiry'?'var(--warn)':'var(--success)'}">${fmtDate(a.certExpiry)}</div></div>
        <div style="background:var(--bg3);border-radius:6px;padding:8px"><div style="font-size:9px;color:var(--t3);margin-bottom:4px">Maint Berikutnya</div><div style="font-size:11px;color:${a.schedMaint&&daysLeft(a.schedMaint)<=7?'var(--warn)':'var(--t2)'}">${fmtDate(a.schedMaint)}</div></div>
        <div style="background:var(--bg3);border-radius:6px;padding:8px"><div style="font-size:9px;color:var(--t3);margin-bottom:4px">Total Repair</div><div style="font-size:11px">Rp ${(a.repairAnalysis||{}).totalRepair||0}Jt</div></div>
      </div>
      ${a.issues?`<div style="background:rgba(255,59,59,.06);border:1px solid rgba(255,59,59,.15);border-radius:6px;padding:8px;margin-bottom:8px;font-size:11px"><i class="fa fa-circle-exclamation" style="color:var(--danger)"></i> <strong>Issues:</strong> ${a.issues}</div>`:''}
      ${(a.repairHistory||[]).length?`<div style="font-size:10px;font-weight:600;color:var(--t3);margin-bottom:6px">RIWAYAT REPAIR</div><table class="tbl"><thead><tr><th>Tanggal</th><th>Deskripsi</th><th>Biaya</th></tr></thead><tbody>${a.repairHistory.map(r=>`<tr><td style="color:var(--t3)">${fmtDate(r.date)}</td><td>${r.desc}</td><td style="color:var(--warn)">Rp ${r.cost}Jt</td></tr>`).join('')}</tbody></table>`:''}
    </div>`).join('')}`;
  } else if(tab==='cmms'){
    const all=DB.assets.flatMap(a=>(a.maintenances||[]).map(m=>({...m,an:a.name,ac:a.code})));
    el.innerHTML=`<div class="stat-row"><div class="stat-box"><div class="sl">Work Orders</div><div class="sv">${all.length}</div></div><div class="stat-box"><div class="sl">Done</div><div class="sv" style="color:var(--success)">${all.filter(m=>m.status==='Done').length}</div></div><div class="stat-box"><div class="sl">Pending</div><div class="sv" style="color:var(--warn)">${all.filter(m=>m.status!=='Done').length}</div></div></div>
    <div class="panel"><table class="tbl"><thead><tr><th>Asset</th><th>Tanggal</th><th>Tipe</th><th>Teknisi</th><th>Biaya</th><th>Catatan</th><th>Status</th></tr></thead><tbody>${all.map(m=>`<tr><td><div style="font-weight:500">${m.an}</div><div style="font-size:10px;color:var(--t3)">${m.ac}</div></td><td style="color:var(--t3)">${fmtDate(m.date)}</td><td><span class="badge ${m.type==='Preventive'?'badge-green':m.type==='Corrective'?'badge-yellow':'badge-blue'}">${m.type}</span></td><td>${m.tech}</td><td>Rp ${m.cost}Jt</td><td style="color:var(--t3)">${m.note}</td><td><span class="badge ${m.status==='Done'?'badge-green':'badge-yellow'}">${m.status}</span></td></tr>`).join('')}</tbody></table></div>`;
  } else {
    el.innerHTML=`<div class="stat-row"><div class="stat-box"><div class="sl">Rekomendasi Replace</div><div class="sv" style="color:var(--danger)">${DB.assets.filter(a=>a.repairAnalysis&&a.repairAnalysis.recommend==='Replace').length}</div></div><div class="stat-box"><div class="sl">Monitor</div><div class="sv" style="color:var(--warn)">${DB.assets.filter(a=>a.repairAnalysis&&a.repairAnalysis.recommend!=='Replace').length}</div></div></div>
    ${DB.assets.map(a=>{const ra=a.repairAnalysis||{};return `<div class="panel"><div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px"><div><div style="font-size:13px;font-weight:600">${a.name}</div><div style="font-size:10px;color:var(--t3)">${a.code} · Tahun ${a.year} · Rp ${a.value}Jt · Umur ${new Date().getFullYear()-a.year}thn</div></div><span class="badge ${ra.recommend==='Replace'?'badge-red':'badge-yellow'}" style="font-size:12px">${ra.recommend||'—'}</span></div><div class="grid-3" style="margin-bottom:10px"><div style="background:var(--bg3);border-radius:6px;padding:8px"><div style="font-size:9px;color:var(--t3);margin-bottom:4px">Total Repair</div><div style="font-size:14px;font-weight:700;color:var(--warn)">Rp ${ra.totalRepair||0}Jt</div></div><div style="background:var(--bg3);border-radius:6px;padding:8px"><div style="font-size:9px;color:var(--t3);margin-bottom:4px">Rasio/Value</div><div style="font-size:14px;font-weight:700;color:${(ra.ratio||0)>30?'var(--danger)':'var(--success)'}">${ra.ratio||0}%</div></div><div style="background:var(--bg3);border-radius:6px;padding:8px"><div style="font-size:9px;color:var(--t3);margin-bottom:4px">Jml Repair</div><div style="font-size:14px;font-weight:700">${(a.repairHistory||[]).length}x</div></div></div><div style="background:rgba(26,140,255,.06);border:1px solid rgba(26,140,255,.15);border-radius:6px;padding:10px;font-size:11px;color:var(--t2)"><i class="fa fa-lightbulb" style="color:var(--warn)"></i> ${ra.reasons||'Belum ada analisa'}</div></div>`;}).join('')}`;
  }
}
function openAssetForm(){
  document.getElementById('modal-title').textContent='Tambah Asset';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-row"><div class="form-group"><label class="form-label">Kode Asset</label><input class="form-input" id="na-code" placeholder="A-000"></div><div class="form-group"><label class="form-label">Nama Asset</label><input class="form-input" id="na-name" placeholder="Nama asset"></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Kategori</label><select class="form-select" id="na-cat"><option>Rotating Equipment</option><option>Static Equipment</option><option>Electrical</option><option>Instrument</option><option>Material Handling</option></select></div><div class="form-group"><label class="form-label">Lokasi</label><input class="form-input" id="na-loc" placeholder="e.g. Pabrik 1"></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Tahun Pembelian</label><input class="form-input" type="number" id="na-year" placeholder="${new Date().getFullYear()}"></div><div class="form-group"><label class="form-label">Nilai Asset (Rp Juta)</label><input class="form-input" type="number" id="na-value" placeholder="0"></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Criticality</label><select class="form-select" id="na-crit"><option>Critical</option><option>High</option><option>Medium</option><option>Low</option></select></div><div class="form-group"><label class="form-label">Vendor</label><input class="form-input" id="na-vendor" placeholder="Nama vendor"></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Status Sertifikasi</label><select class="form-select" id="na-certstatus"><option>Valid</option><option>Near Expiry</option><option>Expired</option></select></div><div class="form-group"><label class="form-label">Cert Expiry</label><input class="form-input" type="date" id="na-certexp"></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Jadwal Maint Berikutnya</label><input class="form-input" type="date" id="na-sched"></div><div class="form-group"><label class="form-label">Usia Ekonomis (thn)</label><input class="form-input" type="number" id="na-life" placeholder="15"></div></div>
    <div class="form-group"><label class="form-label">Issues / Permasalahan</label><textarea class="form-textarea" id="na-issues" placeholder="Deskripsi permasalahan..." rows="2"></textarea></div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" style="flex:1" onclick="saveNewAsset()"><i class="fa fa-save"></i> Simpan</button><button class="btn" onclick="closeModalDirect()">Batal</button></div>`;openModalDirect();
}
function saveNewAsset(){const name=document.getElementById('na-name').value.trim();if(!name){alert('Nama wajib');return;}const value=parseFloat(document.getElementById('na-value').value)||0;DB.assets.push({id:uid(),code:document.getElementById('na-code').value,name,cat:document.getElementById('na-cat').value,loc:document.getElementById('na-loc').value,year:parseInt(document.getElementById('na-year').value)||new Date().getFullYear(),value,life:parseInt(document.getElementById('na-life').value)||15,vendor:document.getElementById('na-vendor').value,crit:document.getElementById('na-crit').value,certStatus:document.getElementById('na-certstatus').value,certExpiry:document.getElementById('na-certexp').value,schedMaint:document.getElementById('na-sched').value,issues:document.getElementById('na-issues').value,maintenances:[],repairHistory:[],repairAnalysis:{totalRepair:0,ratio:0,recommend:'Monitor',reasons:'Belum ada riwayat repair'}});scheduleSave();closeModalDirect();renderAsset();}
function editAsset(id){
  const a=DB.assets.find(x=>x.id===id);if(!a)return;
  document.getElementById('modal-title').textContent='Edit Asset';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-group"><label class="form-label">Issues / Permasalahan</label><textarea class="form-textarea" id="ea-issues">${a.issues||''}</textarea></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Status Cert</label><select class="form-select" id="ea-certstatus">${['Valid','Near Expiry','Expired'].map(s=>`<option${s===a.certStatus?' selected':''}>${s}</option>`).join('')}</select></div><div class="form-group"><label class="form-label">Cert Expiry</label><input class="form-input" type="date" id="ea-certexp" value="${a.certExpiry}"></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Jadwal Maint</label><input class="form-input" type="date" id="ea-sched" value="${a.schedMaint||''}"></div><div class="form-group"><label class="form-label">Criticality</label><select class="form-select" id="ea-crit">${['Critical','High','Medium','Low'].map(s=>`<option${s===a.crit?' selected':''}>${s}</option>`).join('')}</select></div></div>
    <div class="sec-div">Tambah Riwayat Repair</div>
    <div class="form-row"><div class="form-group"><label class="form-label">Tanggal</label><input class="form-input" type="date" id="ea-rdate"></div><div class="form-group"><label class="form-label">Biaya (Rp Juta)</label><input class="form-input" type="number" id="ea-rcost" placeholder="0"></div></div>
    <div class="form-group"><label class="form-label">Deskripsi Repair</label><input class="form-input" id="ea-rdesc" placeholder="Deskripsi repair..."></div>
    <div class="sec-div">Tambah Work Order Maintenance</div>
    <div class="form-row"><div class="form-group"><label class="form-label">Tanggal WO</label><input class="form-input" type="date" id="ea-wdate"></div><div class="form-group"><label class="form-label">Tipe</label><select class="form-select" id="ea-wtype"><option>Preventive</option><option>Corrective</option><option>Inspection</option><option>Breakdown</option></select></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Teknisi</label><input class="form-input" id="ea-wtech" placeholder="Nama teknisi"></div><div class="form-group"><label class="form-label">Biaya WO (Rp Juta)</label><input class="form-input" type="number" id="ea-wcost" placeholder="0"></div></div>
    <div class="form-group"><label class="form-label">Catatan WO</label><input class="form-input" id="ea-wnote" placeholder="Catatan..."></div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" style="flex:1" onclick="saveAssetEdit('${id}')"><i class="fa fa-save"></i> Simpan</button><button class="btn" onclick="closeModalDirect()">Batal</button></div>`;openModalDirect();
}
function saveAssetEdit(id){
  const a=DB.assets.find(x=>x.id===id);if(!a)return;
  a.issues=document.getElementById('ea-issues').value;a.certStatus=document.getElementById('ea-certstatus').value;a.certExpiry=document.getElementById('ea-certexp').value;a.schedMaint=document.getElementById('ea-sched').value;a.crit=document.getElementById('ea-crit').value;
  const rdesc=document.getElementById('ea-rdesc').value.trim();
  if(rdesc){a.repairHistory.push({date:document.getElementById('ea-rdate').value||today(),desc:rdesc,cost:parseFloat(document.getElementById('ea-rcost').value)||0});const tot=a.repairHistory.reduce((s,r)=>s+r.cost,0);a.repairAnalysis={totalRepair:tot,ratio:Math.round(tot/a.value*100),recommend:tot/a.value>.5?'Replace':tot/a.value>.3?'Monitor':'Continue',reasons:tot/a.value>.5?`Rasio ${Math.round(tot/a.value*100)}% >50% — disarankan penggantian`:`Rasio ${Math.round(tot/a.value*100)}%, dalam batas wajar`};}
  const wtech=document.getElementById('ea-wtech').value.trim();
  if(wtech){a.maintenances.push({date:document.getElementById('ea-wdate').value||today(),type:document.getElementById('ea-wtype').value,tech:wtech,cost:parseFloat(document.getElementById('ea-wcost').value)||0,note:document.getElementById('ea-wnote').value,status:'Done'});}scheduleSave();
  closeModalDirect();renderAsset();
}

// ═══════════════ FINDING (ex Audit & HSE) ═══════════════
function renderAudit(){
  autoCheckAuditOverdue();const cont=document.getElementById('content');
  const {bar:audBar,filtered:audFiltered,groups:audGroups,showHeader:audShowHdr}=buildFilterBar('Audit',DB.audit,a=>a.due||'',a=>a.unit||'');
  cont.innerHTML=`
  <div class="stat-row">
    <div class="stat-box"><div class="sl">Total Finding</div><div class="sv">${audFiltered.length}</div></div>
    <div class="stat-box"><div class="sl">Open</div><div class="sv" style="color:var(--danger)">${audFiltered.filter(a=>a.status==='Open').length}</div></div>
    <div class="stat-box"><div class="sl">In Progress</div><div class="sv" style="color:var(--warn)">${audFiltered.filter(a=>a.status==='In Progress').length}</div></div>
    <div class="stat-box"><div class="sl">Overdue</div><div class="sv" style="color:var(--danger)">${audFiltered.filter(a=>a.status==='Overdue').length}</div></div>
    <div class="stat-box"><div class="sl">Completed</div><div class="sv" style="color:var(--success)">${audFiltered.filter(a=>a.status==='Completed'||a.status==='Close').length}</div></div>
  </div>
  ${audBar}
  <!-- Kelola Jenis Finding -->
  <div class="panel" style="padding:12px 16px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-size:12px;font-weight:600"><i class="fa fa-tags" style="color:var(--accent)"></i> Jenis Finding</div>
      <button class="btn btn-sm btn-primary" onclick="addAuditTypeInline()"><i class="fa fa-plus"></i> Tambah Jenis</button>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px" id="audit-type-chips">
      ${DB.auditTypes.map(t=>`
        <div style="display:flex;align-items:center;gap:4px;background:var(--bg4);border:1px solid var(--border2);border-radius:16px;padding:3px 10px">
          <span style="font-size:11px">${t}</span>
          <button onclick="removeAuditTypeInline('${t}')" style="background:none;border:none;cursor:pointer;color:var(--t3);font-size:10px;padding:1px 3px;line-height:1" title="Hapus jenis ini"><i class="fa fa-xmark"></i></button>
        </div>`).join('')}
    </div>
    <div id="audit-type-add-row" style="display:none;margin-top:8px;display:none">
      <div style="display:flex;gap:6px">
        <input id="new-audit-type-input" class="form-input" placeholder="Nama jenis finding baru..." style="flex:1" onkeypress="if(event.key==='Enter')saveAuditTypeInline()">
        <button class="btn btn-sm btn-primary" onclick="saveAuditTypeInline()">Simpan</button>
        <button class="btn btn-sm" onclick="document.getElementById('audit-type-add-row').style.display='none'">Batal</button>
      </div>
    </div>
  </div>

  ${audFiltered.length===0?'<div class="panel" style="text-align:center;color:var(--t3);padding:30px">Tidak ada data sesuai filter.</div>':
    Object.entries(audGroups).map(([gn,gitems])=>
      (audShowHdr?renderGroupHeader(gn,gitems.length):'')+
      gitems.map(a=>{const td=(a.tasks||[]).filter(t=>t.done).length,tt=(a.tasks||[]).length,prog=tt?Math.round(td/tt*100):0,dl=daysLeft(a.due);return `
  <div class="panel" style="border-left:3px solid ${a.status==='Overdue'?'var(--danger)':a.status==='Completed'||a.status==='Close'?'var(--success)':a.status==='In Progress'?'var(--warn)':'var(--accent)'}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px">
      <div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
          <span style="font-size:11px;font-weight:700;color:var(--accent)">${a.id}</span>
          <span class="badge badge-purple">${a.type}</span>
          <span class="badge ${a.sev==='Critical'?'badge-red':a.sev==='Major'?'badge-yellow':'badge-blue'}">${a.sev}</span>
        </div>
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">${a.judul}</div>
        <div style="font-size:10px;color:var(--t3)"><i class="fa fa-building"></i> ${unitName(a.unit)} &nbsp;·&nbsp; <i class="fa fa-user"></i> ${a.owner} &nbsp;·&nbsp; Due: <span style="color:${dl<0?'var(--danger)':dl<=7?'var(--warn)':'var(--t3)'}">${fmtDate(a.due)}${dl<0?' (Overdue '+Math.abs(dl)+'h)':dl<=7?' ('+dl+'h lagi)':''}</span></div>
        ${a.penyebab?`<div style="margin-top:5px;padding:5px 8px;background:rgba(245,158,11,.06);border-left:2px solid var(--warn);border-radius:0 4px 4px 0;font-size:11px"><i class="fa fa-magnifying-glass" style="color:var(--warn)"></i> <strong style="color:var(--warn)">Penyebab:</strong> ${a.penyebab}</div>`:''}
        ${a.dampak?`<div style="margin-top:4px;padding:5px 8px;background:rgba(255,59,59,.06);border-left:2px solid var(--danger);border-radius:0 4px 4px 0;font-size:11px"><i class="fa fa-triangle-exclamation" style="color:var(--danger)"></i> <strong style="color:var(--danger)">Dampak:</strong> ${a.dampak}</div>`:''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
        <span class="badge ${a.status==='Open'?'badge-blue':a.status==='In Progress'?'badge-yellow':a.status==='Overdue'?'badge-red':'badge-green'}">${a.status}</span>
        <div style="display:flex;gap:4px">
          <button class="btn btn-sm" onclick="editAudit('${a.id}')"><i class="fa fa-pen"></i></button>
          <button class="btn btn-sm btn-danger" onclick="deleteAudit('${a.id}')"><i class="fa fa-trash"></i></button>
        </div>
      </div>
    </div>
    <div id="taskblock-${a.id}">${buildTasksHTML(a.tasks,a.id,'audit')}</div>
  </div>`;}).join('')).join('')}`;
}

function addAuditTypeInline(){
  const row=document.getElementById('audit-type-add-row');
  row.style.display='flex';
  setTimeout(()=>{const inp=document.getElementById('new-audit-type-input');if(inp)inp.focus();},50);
}
function saveAuditTypeInline(){
  const inp=document.getElementById('new-audit-type-input');
  const name=inp?inp.value.trim():'';
  if(!name){alert('Nama jenis wajib diisi');return;}
  if(DB.auditTypes.includes(name)){alert('Jenis sudah ada');return;}
  DB.auditTypes.push(name);
  renderAudit();
}
function removeAuditTypeInline(t){
  if(DB.audit.some(a=>a.type===t)){alert(`Jenis "${t}" masih digunakan oleh finding, tidak dapat dihapus`);return;}
  if(!confirm(`Hapus jenis "${t}"?`))return;
  DB.auditTypes=DB.auditTypes.filter(x=>x!==t);
  renderAudit();
}
let newAuditTasks=[];
function openAuditForm(){
  newAuditTasks=[];
  document.getElementById('modal-title').textContent='Tambah Finding';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-row">
      <div class="form-group"><label class="form-label">Unit</label>
        <select class="form-select" id="nau-unit">${DB.units.map(u=>`<option value="${u.id}">${u.name}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">Jenis Finding</label>
        <select class="form-select" id="nau-type">${DB.auditTypes.map(t=>`<option>${t}</option>`).join('')}</select></div>
    </div>
    <div class="form-group"><label class="form-label">Judul / Deskripsi Finding</label>
      <textarea class="form-textarea" id="nau-judul" placeholder="Deskripsi temuan..." rows="2"></textarea></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Severity</label>
        <select class="form-select" id="nau-sev"><option>Critical</option><option>Major</option><option>Minor</option></select></div>
      <div class="form-group"><label class="form-label">CAPA Owner / PIC</label>
        <input class="form-input" id="nau-owner" placeholder="Nama PIC"></div>
    </div>
    <div class="form-group"><label class="form-label">Deadline</label>
      <input class="form-input" type="date" id="nau-due"></div>

    <!-- PENYEBAB -->
    <div class="sec-div" style="margin-top:8px">
      <i class="fa fa-magnifying-glass" style="color:var(--warn)"></i> Penyebab (Root Cause)
    </div>
    <div class="form-group">
      <textarea class="form-textarea" id="nau-penyebab" rows="2" placeholder="Jelaskan akar penyebab temuan ini..."></textarea>
    </div>

    <!-- DAMPAK -->
    <div class="sec-div">
      <i class="fa fa-triangle-exclamation" style="color:var(--danger)"></i> Dampak (Impact)
    </div>
    <div class="form-group">
      <textarea class="form-textarea" id="nau-dampak" rows="2" placeholder="Jelaskan dampak yang ditimbulkan..."></textarea>
    </div>

    <!-- RENCANA TINDAK LANJUT -->
    <div class="sec-div"><i class="fa fa-list-check" style="color:var(--success)"></i> Rencana Tindak Lanjut (CAPA)</div>
    <div id="nau-tasklist" style="margin-bottom:8px">
      <div style="font-size:11px;color:var(--t3);padding:4px 8px">Belum ada rencana. Tambahkan di bawah.</div>
    </div>
    <div class="task-add">
      <input id="nau-newtask" placeholder="Tambah rencana tindak lanjut..." onkeypress="if(event.key==='Enter')addNewAuditTask()">
      <button class="btn btn-sm btn-primary" onclick="addNewAuditTask()"><i class="fa fa-plus"></i></button>
    </div>

    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn btn-primary" style="flex:1" onclick="saveNewAudit()"><i class="fa fa-save"></i> Simpan</button>
      <button class="btn" onclick="closeModalDirect()">Batal</button>
    </div>`;
  openModalDirect();
}

function saveNewAudit(){
  const judul=document.getElementById('nau-judul').value.trim();
  if(!judul){alert('Deskripsi wajib');return;}
  const nextId='F-'+String(DB.audit.length+1).padStart(3,'0');
  DB.audit.push({
    id:nextId,
    unit:document.getElementById('nau-unit').value,
    type:document.getElementById('nau-type').value,
    judul,
    sev:document.getElementById('nau-sev').value,
    owner:document.getElementById('nau-owner').value,
    due:document.getElementById('nau-due').value,
    penyebab:document.getElementById('nau-penyebab').value.trim(),
    dampak:document.getElementById('nau-dampak').value.trim(),
    status:'Open',
    tasks:[...newAuditTasks]
  });
  newAuditTasks=[];
  scheduleSave();closeModalDirect();renderAudit();updateBadges();
}

function editAudit(id){
  const a=DB.audit.find(x=>x.id===id);if(!a)return;
  document.getElementById('modal-title').textContent='Edit Finding';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-row">
      <div class="form-group"><label class="form-label">Unit</label>
        <select class="form-select" id="eau-unit">${DB.units.map(u=>`<option value="${u.id}"${u.id===a.unit?' selected':''}>${u.name}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">Jenis Finding</label>
        <select class="form-select" id="eau-type">${DB.auditTypes.map(t=>`<option${t===a.type?' selected':''}>${t}</option>`).join('')}</select></div>
    </div>
    <div class="form-group"><label class="form-label">Judul / Deskripsi Finding</label>
      <textarea class="form-textarea" id="eau-judul" rows="2">${a.judul||''}</textarea></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Status</label>
        <select class="form-select" id="eau-status">${['Open','In Progress','Completed','Close'].map(s=>`<option${s===a.status?' selected':''}>${s}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">Severity</label>
        <select class="form-select" id="eau-sev">${['Critical','Major','Minor'].map(s=>`<option${s===a.sev?' selected':''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">CAPA Owner / PIC</label>
        <input class="form-input" id="eau-owner" value="${a.owner||''}"></div>
      <div class="form-group"><label class="form-label">Deadline</label>
        <input class="form-input" type="date" id="eau-due" value="${a.due||''}"></div>
    </div>

    <div class="sec-div" style="margin-top:8px">
      <i class="fa fa-magnifying-glass" style="color:var(--warn)"></i> Penyebab (Root Cause)
    </div>
    <div class="form-group">
      <textarea class="form-textarea" id="eau-penyebab" rows="2" placeholder="Akar penyebab temuan...">${a.penyebab||''}</textarea>
    </div>

    <div class="sec-div">
      <i class="fa fa-triangle-exclamation" style="color:var(--danger)"></i> Dampak (Impact)
    </div>
    <div class="form-group">
      <textarea class="form-textarea" id="eau-dampak" rows="2" placeholder="Dampak yang ditimbulkan...">${a.dampak||''}</textarea>
    </div>

    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-primary" style="flex:1" onclick="saveAuditEdit('${id}')"><i class="fa fa-save"></i> Simpan</button>
      <button class="btn" onclick="closeModalDirect()">Batal</button>
    </div>`;
  openModalDirect();
}

function saveAuditEdit(id){
  const a=DB.audit.find(x=>x.id===id);if(!a)return;
  a.unit=document.getElementById('eau-unit')?.value||a.unit;
  a.type=document.getElementById('eau-type')?.value||a.type;
  a.judul=document.getElementById('eau-judul')?.value||a.judul;
  a.status=document.getElementById('eau-status').value;
  a.sev=document.getElementById('eau-sev').value;
  a.owner=document.getElementById('eau-owner').value;
  a.due=document.getElementById('eau-due').value;
  a.penyebab=document.getElementById('eau-penyebab')?.value||a.penyebab||'';
  a.dampak=document.getElementById('eau-dampak')?.value||a.dampak||'';
  scheduleSave();closeModalDirect();renderAudit();updateBadges();
}
function addNewAuditTask(){
  const inp=document.getElementById('nau-newtask');
  if(!inp||!inp.value.trim())return;
  newAuditTasks.push({id:uid(),text:inp.value.trim(),done:false,weight:0});
  inp.value=''; renderNewAuditTasks();
}
function removeNewAuditTask(i){ newAuditTasks.splice(i,1); renderNewAuditTasks(); }
function renderNewAuditTasks(){
  const el=document.getElementById('nau-tasklist');if(!el)return;
  if(!newAuditTasks.length){el.innerHTML='<div style="font-size:11px;color:var(--t3);padding:4px 8px">Belum ada rencana.</div>';return;}
  el.innerHTML=newAuditTasks.map((t,i)=>`
    <div class="task-item">
      <input type="checkbox" disabled style="width:14px;height:14px;accent-color:var(--accent);flex-shrink:0">
      <span class="task-text">${t.text}</span>
      <button class="btn btn-sm" style="padding:1px 5px;font-size:9px;opacity:.5" onclick="removeNewAuditTask(${i})"><i class="fa fa-xmark"></i></button>
    </div>`).join('');
}

// ═══════════════ LISENSI, SOP & PERSONIL ═══════════════
function renderLicense(){
  autoCheckLicenseStatus();const cont=document.getElementById('content');
  const at=cont.getAttribute('data-ltab')||'Peralatan';cont.setAttribute('data-ltab',at);
  const licBase=DB.licenses.filter(l=>l.type===at);
  const {bar:licBar,filtered,groups:licGroups,showHeader:licShowHdr}=buildFilterBar('License',licBase,l=>l.expiry||'',l=>l.unit||'');
  cont.innerHTML=`
  <div class="stat-row">
    <div class="stat-box"><div class="sl">Total Lisensi</div><div class="sv">${DB.licenses.length}</div></div>
    <div class="stat-box"><div class="sl">Expired</div><div class="sv" style="color:var(--danger)">${DB.licenses.filter(l=>l.status==='Expired').length}</div></div>
    <div class="stat-box"><div class="sl">Near Expiry ≤6bln</div><div class="sv" style="color:var(--warn)">${DB.licenses.filter(l=>l.status==='Near Expiry').length}</div></div>
    <div class="stat-box"><div class="sl">Valid</div><div class="sv" style="color:var(--success)">${DB.licenses.filter(l=>l.status==='Valid').length}</div></div>
  </div>
  ${licBar}<div class="tabs">${['Peralatan','SOP','Personil'].map(t=>`<button class="tab ${t===at?'active':''}" onclick="setLicTab('${t}',this)">${t}</button>`).join('')}</div>
  <div class="panel">
    <table class="tbl">
      <thead><tr><th>Nama</th><th>Penerbit</th><th>Unit</th><th>Pemegang</th><th>Berlaku</th><th>Expired</th><th>Sisa Hari</th><th>Status</th><th>Dokumen</th><th>Aksi</th></tr></thead>
      <tbody>
        ${filtered.map(l=>{const dl=daysLeft(l.expiry);const sc=l.status==='Expired'?'badge-red':l.status==='Near Expiry'?'badge-yellow':'badge-green';return `<tr>
          <td><div style="font-weight:500">${l.name}</div>${l.notes?`<div style="font-size:10px;color:var(--t3)">${l.notes}</div>`:''}</td>
          <td style="color:var(--t3)">${l.issuer}</td><td>${unitName(l.unit)}</td><td>${l.holder}</td>
          <td style="color:var(--t3)">${fmtDate(l.issued)}</td>
          <td style="color:${l.status==='Expired'?'var(--danger)':l.status==='Near Expiry'?'var(--warn)':'var(--t2)'};font-weight:600">${fmtDate(l.expiry)}</td>
          <td style="font-weight:600;color:${dl<0?'var(--danger)':dl<=30?'var(--danger)':dl<=180?'var(--warn)':'var(--success)'}">${dl===null?'—':dl<0?`Expired ${Math.abs(dl)}h`:dl+'h'}</td>
          <td><span class="badge ${sc}">${l.status}</span></td>
          <td>${l.docLink?`<a href="${l.docLink}" target="_blank" rel="noopener" class="btn btn-sm btn-success" style="text-decoration:none"><i class="fa fa-download"></i> Buka</a>`:'<span style="color:var(--t3);font-size:10px">—</span>'}</td>
          <td><button class="btn btn-sm" onclick="editLicense('${l.id}')"><i class="fa fa-pen"></i></button> <button class="btn btn-sm btn-danger" onclick="deleteLicense('${l.id}')"><i class="fa fa-trash"></i></button></td>
        </tr>`;}).join('')||`<tr><td colspan="10" style="text-align:center;color:var(--t3);padding:20px">Belum ada data ${at}</td></tr>`}
      </tbody>
    </table>
  </div>`;
}
function setLicTab(tab,btn){document.getElementById('content').setAttribute('data-ltab',tab);document.querySelectorAll('.tabs .tab').forEach(b=>b.classList.remove('active'));btn.classList.add('active');renderLicense();}
function openLicenseForm(){
  document.getElementById('modal-title').textContent='Tambah Lisensi/SOP/Sertifikat';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-row"><div class="form-group"><label class="form-label">Tipe</label><select class="form-select" id="nl-type"><option>Peralatan</option><option>SOP</option><option>Personil</option></select></div><div class="form-group"><label class="form-label">Unit</label><select class="form-select" id="nl-unit">${DB.units.map(u=>`<option value="${u.id}">${u.name}</option>`).join('')}</select></div></div>
    <div class="form-group"><label class="form-label">Nama Lisensi / Sertifikat / SOP</label><input class="form-input" id="nl-name" placeholder="Nama dokumen"></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Penerbit</label><input class="form-input" id="nl-issuer" placeholder="e.g. Kemnaker, BNSP, Internal"></div><div class="form-group"><label class="form-label">Pemegang</label><input class="form-input" id="nl-holder" placeholder="Nama pemegang / unit"></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Tanggal Berlaku</label><input class="form-input" type="date" id="nl-issued"></div><div class="form-group"><label class="form-label">Tanggal Expired</label><input class="form-input" type="date" id="nl-expiry"></div></div>
    <div class="form-group"><label class="form-label">Catatan</label><input class="form-input" id="nl-notes" placeholder="Catatan..."></div>
    <div class="form-group">
      <label class="form-label"><i class="fa fa-link" style="color:var(--accent)"></i> Link Dokumen (Google Drive / SharePoint / URL)</label>
      <input class="form-input" id="nl-doclink" placeholder="https://drive.google.com/... atau link dokumen lainnya">
      <div style="font-size:10px;color:var(--t3);margin-top:4px">Paste link dokumen agar bisa dibuka langsung dari tabel</div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" style="flex:1" onclick="saveNewLicense()"><i class="fa fa-save"></i> Simpan</button><button class="btn" onclick="closeModalDirect()">Batal</button></div>`;openModalDirect();
}
function saveNewLicense(){const name=document.getElementById('nl-name').value.trim();if(!name){alert('Nama wajib');return;}const l={id:uid(),type:document.getElementById('nl-type').value,name,issuer:document.getElementById('nl-issuer').value,unit:document.getElementById('nl-unit').value,holder:document.getElementById('nl-holder').value,issued:document.getElementById('nl-issued').value,expiry:document.getElementById('nl-expiry').value,status:'Valid',notes:document.getElementById('nl-notes').value,docLink:document.getElementById('nl-doclink').value.trim()};DB.licenses.push(l);autoCheckLicenseStatus();scheduleSave();closeModalDirect();renderLicense();updateBadges();}
function editLicense(id){const l=DB.licenses.find(x=>x.id===id);if(!l)return;document.getElementById('modal-title').textContent='Edit Lisensi';document.getElementById('modal-body').innerHTML=`<div class="form-row"><div class="form-group"><label class="form-label">Tanggal Berlaku</label><input class="form-input" type="date" id="el-issued" value="${l.issued}"></div><div class="form-group"><label class="form-label">Tanggal Expired</label><input class="form-input" type="date" id="el-expiry" value="${l.expiry}"></div></div><div class="form-group"><label class="form-label">Pemegang</label><input class="form-input" id="el-holder" value="${l.holder}"></div><div class="form-group"><label class="form-label">Catatan</label><input class="form-input" id="el-notes" value="${l.notes||''}"></div><div class="form-group"><label class="form-label"><i class="fa fa-link" style="color:var(--accent)"></i> Link Dokumen</label><input class="form-input" id="el-doclink" value="${l.docLink||''}" placeholder="https://..."></div><div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" style="flex:1" onclick="saveLicenseEdit('${id}')"><i class="fa fa-save"></i> Simpan</button><button class="btn" onclick="closeModalDirect()">Batal</button></div>`;openModalDirect();}
function saveLicenseEdit(id){const l=DB.licenses.find(x=>x.id===id);if(!l)return;l.issued=document.getElementById('el-issued').value;l.expiry=document.getElementById('el-expiry').value;l.holder=document.getElementById('el-holder').value;l.notes=document.getElementById('el-notes').value;l.docLink=document.getElementById('el-doclink').value.trim();autoCheckLicenseStatus();scheduleSave();closeModalDirect();renderLicense();updateBadges();}
function deleteLicense(id){if(!confirm('Hapus?'))return;DB.licenses=DB.licenses.filter(x=>x.id!==id);scheduleSave();renderLicense();}

// ═══════════════ UNIT MANAGEMENT ═══════════════
function renderUnits(){
  const cont=document.getElementById('content');
  const byDiv={};DB.units.forEach(u=>{if(!byDiv[u.divisi])byDiv[u.divisi]=[];byDiv[u.divisi].push(u);});
  cont.innerHTML=`
  <div class="panel">
    <div class="panel-hd"><div class="panel-title"><i class="fa fa-sitemap"></i> Manajemen Divisi</div><button class="btn btn-primary btn-sm" onclick="openAddDivision()"><i class="fa fa-plus"></i> Tambah Divisi</button></div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${DB.divisions.map(d=>`<div style="display:flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid var(--border2);border-radius:20px;padding:4px 12px">
        <span style="font-size:12px">${d}</span>
        <span style="font-size:10px;color:var(--t3)">(${DB.units.filter(u=>u.divisi===d).length})</span>
        <button class="btn btn-sm" style="padding:1px 5px;border:none;opacity:.5" onclick="renameDivision('${d}')"><i class="fa fa-pen"></i></button>
        <button class="btn btn-sm btn-danger" style="padding:1px 5px;border:none;opacity:.5" onclick="deleteDivision('${d}')"><i class="fa fa-trash"></i></button>
      </div>`).join('')}
    </div>
  </div>
  ${Object.entries(byDiv).map(([div,units])=>`
  <div class="panel">
    <div class="panel-hd"><div><div class="panel-title">${div}</div><div class="panel-sub">${units.length} unit</div></div></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
      ${units.map(u=>`<div style="background:var(--bg3);border-radius:8px;padding:14px;border:1px solid ${u.color}30;border-left:4px solid ${u.color}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><div style="width:36px;height:36px;border-radius:8px;background:${u.color}18;display:flex;align-items:center;justify-content:center"><span style="font-size:11px;font-weight:700;color:${u.color}">${u.code}</span></div><div><div style="font-size:12px;font-weight:600">${u.name}</div><div style="font-size:10px;color:var(--t3)">${u.head}</div></div></div>
        <div style="font-size:10px;color:var(--t3);margin-bottom:8px">${u.loc} · ${u.members} anggota</div>
        <div style="display:flex;gap:6px"><button class="btn btn-sm" style="flex:1;font-size:10px" onclick="editUnit('${u.id}')"><i class="fa fa-pen"></i> Edit</button><button class="btn btn-sm btn-danger" style="font-size:10px" onclick="deleteUnit('${u.id}')"><i class="fa fa-trash"></i></button></div>
      </div>`).join('')}
    </div>
  </div>`).join('')}`;
}
function openAddDivision(){document.getElementById('modal-title').textContent='Tambah Divisi';document.getElementById('modal-body').innerHTML=`<div class="form-group"><label class="form-label">Nama Divisi</label><input class="form-input" id="nd-name" placeholder="e.g. Produksi, Teknik"></div><div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" style="flex:1" onclick="saveNewDivision()"><i class="fa fa-save"></i> Simpan</button><button class="btn" onclick="closeModalDirect()">Batal</button></div>`;openModalDirect();}
function saveNewDivision(){const name=document.getElementById('nd-name').value.trim();if(!name||DB.divisions.includes(name)){alert(name?'Divisi sudah ada':'Nama wajib');return;}DB.divisions.push(name);scheduleSave();closeModalDirect();renderUnits();}
function renameDivision(old){const name=prompt('Nama baru divisi:',old);if(!name||name===old)return;if(DB.divisions.includes(name)){alert('Divisi sudah ada');return;}DB.divisions=DB.divisions.map(d=>d===old?name:d);DB.units.forEach(u=>{if(u.divisi===old)u.divisi=name;});renderUnits();}
function deleteDivision(name){if(DB.units.some(u=>u.divisi===name)){alert('Tidak bisa hapus divisi yang masih memiliki unit');return;}if(!confirm(`Hapus divisi "${name}"?`))return;DB.divisions=DB.divisions.filter(d=>d!==name);renderUnits();}
function openAddModal(){
  document.getElementById('modal-title').textContent='Tambah Unit Baru';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-row"><div class="form-group"><label class="form-label">Nama Unit</label><input class="form-input" id="nu-name" placeholder="e.g. Unit Produksi"></div><div class="form-group"><label class="form-label">Kode Unit</label><input class="form-input" id="nu-code" placeholder="e.g. PROD" style="text-transform:uppercase"></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Divisi</label><select class="form-select" id="nu-divisi">${DB.divisions.map(d=>`<option>${d}</option>`).join('')}</select></div><div class="form-group"><label class="form-label">Kepala Unit</label><input class="form-input" id="nu-head" placeholder="Nama kepala unit"></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Email</label><input class="form-input" id="nu-email" type="email" placeholder="kepala@corp.com"></div><div class="form-group"><label class="form-label">Jumlah Anggota</label><input class="form-input" id="nu-members" type="number" placeholder="0"></div></div>
    <div class="form-row"><div class="form-group"><label class="form-label">Lokasi</label><input class="form-input" id="nu-loc" placeholder="e.g. Pabrik 1"></div><div class="form-group"><label class="form-label">Warna Unit</label><input type="color" id="nu-color" value="#1a8cff" style="width:100%;height:36px;border-radius:6px;border:1px solid var(--border);cursor:pointer;background:transparent"></div></div>
    <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">${['#1a8cff','#22c55e','#f59e0b','#ff3b3b','#a855f7','#ec4899','#14b8a6','#f97316'].map(c=>`<div onclick="document.getElementById('nu-color').value='${c}'" style="width:20px;height:20px;border-radius:50%;background:${c};cursor:pointer;border:2px solid transparent" onmouseover="this.style.border='2px solid white'" onmouseout="this.style.border='2px solid transparent'"></div>`).join('')}</div>
    <div class="form-group"><label class="form-label">Deskripsi</label><textarea class="form-textarea" id="nu-desc" placeholder="Fungsi unit..." rows="2"></textarea></div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" style="flex:1" onclick="addNewUnit()"><i class="fa fa-plus"></i> Tambah Unit</button><button class="btn" onclick="closeModalDirect()">Batal</button></div>`;openModalDirect();
}
function addNewUnit(){const name=document.getElementById('nu-name').value.trim();if(!name){alert('Nama wajib');return;}DB.units.push({id:'u'+uid(),name,code:document.getElementById('nu-code').value.toUpperCase(),head:document.getElementById('nu-head').value,email:document.getElementById('nu-email').value,color:document.getElementById('nu-color').value,divisi:document.getElementById('nu-divisi').value,members:parseInt(document.getElementById('nu-members').value)||0,desc:document.getElementById('nu-desc').value,loc:document.getElementById('nu-loc').value});scheduleSave();closeModalDirect();renderUnits();}
function editUnit(id){const u=DB.units.find(x=>x.id===id);if(!u)return;document.getElementById('modal-title').textContent='Edit Unit';document.getElementById('modal-body').innerHTML=`<div class="form-row"><div class="form-group"><label class="form-label">Nama Unit</label><input class="form-input" id="eu-name" value="${u.name}"></div><div class="form-group"><label class="form-label">Kode</label><input class="form-input" id="eu-code" value="${u.code}"></div></div><div class="form-row"><div class="form-group"><label class="form-label">Divisi</label><select class="form-select" id="eu-divisi">${DB.divisions.map(d=>`<option${d===u.divisi?' selected':''}>${d}</option>`).join('')}</select></div><div class="form-group"><label class="form-label">Kepala Unit</label><input class="form-input" id="eu-head" value="${u.head}"></div></div><div class="form-row"><div class="form-group"><label class="form-label">Anggota</label><input class="form-input" type="number" id="eu-members" value="${u.members}"></div><div class="form-group"><label class="form-label">Warna</label><input type="color" id="eu-color" value="${u.color}" style="width:100%;height:36px;border-radius:6px;border:1px solid var(--border);cursor:pointer;background:transparent"></div></div><div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" style="flex:1" onclick="saveUnitEdit('${id}')"><i class="fa fa-save"></i> Simpan</button><button class="btn" onclick="closeModalDirect()">Batal</button></div>`;openModalDirect();}
function saveUnitEdit(id){const u=DB.units.find(x=>x.id===id);if(!u)return;u.name=document.getElementById('eu-name').value||u.name;u.code=document.getElementById('eu-code').value||u.code;u.divisi=document.getElementById('eu-divisi').value;u.head=document.getElementById('eu-head').value;u.members=parseInt(document.getElementById('eu-members').value)||u.members;u.color=document.getElementById('eu-color').value;scheduleSave();closeModalDirect();renderUnits();}
function deleteUnit(id){if(DB.programs.some(p=>p.unitId===id)){alert('Unit masih memiliki program, tidak dapat dihapus');return;}if(!confirm('Hapus unit?'))return;DB.units=DB.units.filter(x=>x.id!==id);scheduleSave();renderUnits();}

// ═══════════════ USER MANAGEMENT ═══════════════
function renderUsers(){
  const cont=document.getElementById('content');
  cont.innerHTML=`
  <div class="stat-row">
    <div class="stat-box"><div class="sl">Total User</div><div class="sv">${DB.users.length}</div></div>
    <div class="stat-box"><div class="sl">Director / GM</div><div class="sv" style="color:var(--danger)">${DB.users.filter(u=>u.role==='Director'||u.role==='General Manager').length}</div></div>
    <div class="stat-box"><div class="sl">Manager</div><div class="sv" style="color:var(--warn)">${DB.users.filter(u=>u.role==='Manager').length}</div></div>
    <div class="stat-box"><div class="sl">Staff / Viewer</div><div class="sv" style="color:var(--success)">${DB.users.filter(u=>u.role==='Staff'||u.role==='Viewer'||u.role==='Supervisor').length}</div></div>
  </div>
  <div class="panel">
    <div class="panel-hd"><div class="panel-title">Daftar User</div></div>
    <table class="tbl">
      <thead><tr><th>Nama</th><th>Email</th><th>Role</th><th>Unit / Divisi</th><th>Last Login</th><th>Status</th><th style="text-align:center">Aksi</th></tr></thead>
      <tbody>
        ${DB.users.map((u,idx)=>{
          const rc={Director:'badge-red','General Manager':'badge-red',Manager:'badge-yellow',Supervisor:'badge-blue',Staff:'badge-green',Viewer:'badge-teal'}[u.role]||'badge-blue';
          const ini=u.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
          return `<tr>
            <td><div style="display:flex;align-items:center;gap:8px">
              <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;color:#fff">${ini}</div>
              <div><div style="font-weight:600;font-size:12px">${u.name}</div><div style="font-size:10px;color:var(--t3)">${u.email||'—'}</div></div>
            </div></td>
            <td style="color:var(--t3);font-size:11px">${u.email||'—'}</td>
            <td><span class="badge ${rc}">${u.role}</span></td>
            <td style="color:var(--t2);font-size:11px">${u.unit||'—'}</td>
            <td style="color:var(--t3);font-size:11px">${u.last||'—'}</td>
            <td><span class="badge badge-green">Active</span></td>
            <td style="text-align:center">
              <div style="display:flex;gap:4px;justify-content:center">
                <button class="btn btn-sm" onclick="editUser(${idx})" title="Edit"><i class="fa fa-pen"></i></button>
                <button class="btn btn-sm btn-danger" onclick="deleteUser(${idx})" title="Hapus"><i class="fa fa-trash"></i></button>
              </div>
            </td>
          </tr>`;}).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--t3);padding:20px">Belum ada user.</td></tr>'}
      </tbody>
    </table>
  </div>
  <div class="panel">
    <div class="panel-hd">
      <div><div class="panel-title">Role Permission Matrix</div><div class="panel-sub">Klik sel untuk ganti: <span style="color:var(--t3)">— No Access</span> → <span style="color:var(--warn)">View</span> → <span style="color:var(--success)">Edit</span> · Klik nama jabatan untuk edit/hapus</div></div>
      <button class="btn btn-primary btn-sm" onclick="addRole()"><i class="fa fa-plus"></i> Tambah Jabatan</button>
    </div>
    <div style="overflow-x:auto">
    <table class="tbl" style="min-width:600px">
      <thead><tr>
        <th style="min-width:140px">Module</th>
        ${DB.roles.map((r,ri)=>`<th style="text-align:center;min-width:90px">
          <div style="display:flex;flex-direction:column;align-items:center;gap:3px">
            <span class="badge ${r==='Director'||r==='General Manager'?'badge-red':r==='Manager'?'badge-yellow':r==='Supervisor'?'badge-blue':r==='Staff'?'badge-green':'badge-teal'}" style="white-space:nowrap">${r}</span>
            <div style="display:flex;gap:3px">
              <button class="btn btn-sm" style="padding:1px 5px;font-size:9px" onclick="editRole(${ri})" title="Edit nama jabatan"><i class="fa fa-pen"></i></button>
              <button class="btn btn-sm btn-danger" style="padding:1px 5px;font-size:9px" onclick="deleteRole(${ri})" title="Hapus jabatan"><i class="fa fa-trash"></i></button>
            </div>
          </div>
        </th>`).join('')}
      </tr></thead>
      <tbody>
        ${['Dashboard','KPI Management','Program Kerja','Risk & EWS','Pengadaan','Asset & CMMS','Finding','Lisensi & SOP','User Management','Settings'].map(mod=>`
        <tr>
          <td style="font-weight:500;font-size:11px">${mod}</td>
          ${DB.roles.map((r,ri)=>{
            const perm=(DB.rolePermissions[r]||{})[mod]||0;
            const label=perm===2?'Edit':perm===1?'View':'—';
            const color=perm===2?'var(--success)':perm===1?'var(--warn)':'var(--t3)';
            const bg=perm===2?'rgba(34,197,94,.08)':perm===1?'rgba(245,158,11,.08)':'transparent';
            const border=perm===2?'rgba(34,197,94,.3)':perm===1?'rgba(245,158,11,.3)':'var(--border)';
            return `<td style="text-align:center">
              <span onclick="togglePerm('${r}','${mod}')"
                style="cursor:pointer;font-size:11px;font-weight:700;color:${color};padding:3px 10px;border-radius:6px;border:1px solid ${border};background:${bg};transition:.15s;display:inline-block;min-width:40px"
                title="Klik untuk ganti: No Access → View Only → Edit → No Access">
                ${label}
              </span>
            </td>`;}).join('')}
        </tr>`).join('')}
      </tbody>
    </table>
    </div>
  </div>`;
}

const MODULES = ['Dashboard','KPI Management','Program Kerja','Risk & EWS','Pengadaan','Asset & CMMS','Finding','Lisensi & SOP','User Management','Settings'];

function togglePerm(role, mod){
  if(!DB.rolePermissions[role]) DB.rolePermissions[role]={};
  const cur = DB.rolePermissions[role][mod]||0;
  // Cycle: 0 (No) → 1 (View) → 2 (Edit) → 0
  DB.rolePermissions[role][mod] = (cur+1)%3;
  scheduleSave();
  renderUsers();
}

function addRole(){
  const name = prompt('Nama jabatan baru:','');
  if(!name||!name.trim()) return;
  const n = name.trim();
  if(DB.roles.includes(n)){alert('Jabatan sudah ada');return;}
  DB.roles.push(n);
  DB.rolePermissions[n] = {};
  MODULES.forEach(m=>{ DB.rolePermissions[n][m]=0; });
  scheduleSave(); renderUsers();
}

function editRole(idx){
  const old = DB.roles[idx];
  const newName = prompt('Ganti nama jabatan:', old);
  if(!newName||!newName.trim()||newName.trim()===old) return;
  const n = newName.trim();
  if(DB.roles.includes(n)){alert('Jabatan sudah ada');return;}
  // Rename in roles array
  DB.roles[idx] = n;
  // Rename key in rolePermissions
  DB.rolePermissions[n] = DB.rolePermissions[old]||{};
  delete DB.rolePermissions[old];
  // Rename in all users
  DB.users.forEach(u=>{ if(u.role===old) u.role=n; });
  scheduleSave(); renderUsers();
}

function deleteRole(idx){
  const r = DB.roles[idx];
  if(DB.users.some(u=>u.role===r)){
    alert(`Jabatan "${r}" masih digunakan oleh ${DB.users.filter(u=>u.role===r).length} user. Ubah role user tersebut terlebih dahulu.`);
    return;
  }
  if(!confirm(`Hapus jabatan "${r}"?`)) return;
  DB.roles.splice(idx,1);
  delete DB.rolePermissions[r];
  scheduleSave(); renderUsers();
}

function openUserForm(){
  document.getElementById('modal-title').textContent='Tambah User';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-row">
      <div class="form-group"><label class="form-label">Nama Lengkap</label><input class="form-input" id="nu2-name" placeholder="Nama lengkap"></div>
      <div class="form-group"><label class="form-label">Email</label><input class="form-input" type="email" id="nu2-email" placeholder="user@aviasi.co.id"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Role / Jabatan</label>
        <select class="form-select" id="nu2-role">
          ${DB.roles.map(r=>`<option>${r}</option>`).join('')}
        </select></div>
      <div class="form-group"><label class="form-label">Unit</label>
        <select class="form-select" id="nu2-unit">
          <option value="All Units">All Units</option>
          ${DB.units.map(u=>`<option value="${u.name}">${u.name}</option>`).join('')}
        </select></div>
    </div>
    <div class="form-group"><label class="form-label">Password</label>
      <input class="form-input" type="password" id="nu2-pass" placeholder="Password login" autocomplete="new-password"></div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn btn-primary" style="flex:1" onclick="saveNewUser()"><i class="fa fa-save"></i> Simpan</button>
      <button class="btn" onclick="closeModalDirect()">Batal</button>
    </div>`;
  openModalDirect();
}

async function saveNewUser(){
  const name=document.getElementById('nu2-name').value.trim();
  if(!name){alert('Nama wajib diisi');return;}
  const email=document.getElementById('nu2-email').value.trim().toLowerCase();
  if(!email){alert('Email wajib diisi');return;}
  const pass=document.getElementById('nu2-pass').value.trim();
  if(!pass||pass.length<6){alert('Password wajib diisi minimal 6 karakter');return;}
  const btn=document.querySelector('#modal-body .btn-primary');
  if(btn){btn.disabled=true;btn.innerHTML='<i class="fa fa-spinner fa-spin"></i> Menyimpan...';}
  try{
    _initFirebaseOnce();
    // Buat akun di Firebase Auth (pakai secondary app agar tidak logout user aktif)
    const secApp = firebase.initializeApp(FIREBASE_CONFIG,'dirops-reg-'+Date.now());
    const secAuth = secApp.auth();
    await secAuth.createUserWithEmailAndPassword(email,pass);
    await secAuth.signOut();
    secApp.delete().catch(()=>{});
    DB.users.push({id:uid(),name,email,role:document.getElementById('nu2-role').value,unit:document.getElementById('nu2-unit').value,password:pass,last:'Baru',status:'Active',isAdmin:false});
    scheduleSave();closeModalDirect();renderUsers();
    alert(`User "${name}" berhasil dibuat dan dapat login.`);
  }catch(e){
    if(btn){btn.disabled=false;btn.innerHTML='<i class="fa fa-save"></i> Simpan';}
    const msg={'auth/email-already-in-use':'Email sudah terdaftar di sistem autentikasi.','auth/weak-password':'Password terlalu lemah (min 6 karakter).','auth/invalid-email':'Format email tidak valid.'}[e.code]||('Gagal membuat akun: '+(e.message||e.code));
    alert(msg);
  }
}

function editUser(idx){
  const u=DB.users[idx];if(!u)return;
  document.getElementById('modal-title').textContent='Edit User';
  document.getElementById('modal-body').innerHTML=`
    <div class="form-row">
      <div class="form-group"><label class="form-label">Nama Lengkap</label>
        <input class="form-input" id="eu-name" value="${u.name}"></div>
      <div class="form-group"><label class="form-label">Email</label>
        <input class="form-input" type="email" id="eu-email" value="${u.email||''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Role / Jabatan</label>
        <select class="form-select" id="eu-role">
          ${DB.roles.map(r=>`<option${r===u.role?' selected':''}>${r}</option>`).join('')}
        </select></div>
      <div class="form-group"><label class="form-label">Unit</label>
        <select class="form-select" id="eu-unit">
          <option value="All Units"${u.unit==='All Units'?' selected':''}>All Units</option>
          ${DB.units.map(un=>`<option value="${un.name}"${un.name===u.unit?' selected':''}>${un.name}</option>`).join('')}
        </select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Password Baru <span style="color:var(--t3);font-weight:400">(kosongkan = tidak ganti)</span></label>
        <input class="form-input" type="password" id="eu-pass" placeholder="Password baru..."></div>
      <div class="form-group"><label class="form-label">Status</label>
        <select class="form-select" id="eu-status">
          <option${(u.status||'Active')==='Active'?' selected':''}>Active</option>
          <option${u.status==='Inactive'?' selected':''}>Inactive</option>
          <option${u.status==='Suspended'?' selected':''}>Suspended</option>
        </select></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn btn-primary" style="flex:1" onclick="saveEditUser(${idx})"><i class="fa fa-save"></i> Simpan</button>
      <button class="btn" onclick="closeModalDirect()">Batal</button>
    </div>`;
  openModalDirect();
}

async function saveEditUser(idx){
  const u=DB.users[idx];if(!u)return;
  u.name=document.getElementById('eu-name').value.trim()||u.name;
  u.email=document.getElementById('eu-email').value.trim().toLowerCase()||u.email;
  u.role=document.getElementById('eu-role').value;
  u.unit=document.getElementById('eu-unit').value;
  u.status=document.getElementById('eu-status').value;
  const newPass=document.getElementById('eu-pass').value.trim();
  if(newPass){
    if(newPass.length<6){alert('Password minimal 6 karakter');return;}
    u.password=newPass;
    // Update password di Firebase Auth — user harus login ulang untuk apply
    try{
      _initFirebaseOnce();
      const fbUser=_fbAuth.currentUser;
      if(fbUser&&fbUser.email===u.email) await fbUser.updatePassword(newPass);
    }catch(e){ console.warn('Update Firebase password:',e.message); }
  }
  scheduleSave();closeModalDirect();renderUsers();
}

function deleteUser(idx){
  const u=DB.users[idx];if(!u)return;
  if(!confirm(`Hapus user "${u.name}"?`))return;
  DB.users.splice(idx,1);
  scheduleSave();renderUsers();
}

// ═══════════════ SETTINGS & BACKUP ═══════════════
function renderSettings(){
  const cont=document.getElementById('content');
  cont.innerHTML=`
  <div class="grid-2">
    <div>
      <div class="settings-card">
        <div style="font-size:13px;font-weight:600;margin-bottom:4px"><i class="fa fa-cloud-arrow-down" style="color:var(--accent)"></i> Backup Data</div>
        <div style="font-size:11px;color:var(--t3);margin-bottom:12px">Unduh semua data DIROPS MONITORING dalam format JSON untuk backup atau migrasi.</div>
        <button class="btn btn-primary" onclick="backupData('json')" style="width:100%;justify-content:center;margin-bottom:6px"><i class="fa fa-file-code"></i> Download JSON Backup</button>
        <button class="btn" onclick="backupData('csv')" style="width:100%;justify-content:center"><i class="fa fa-file-csv"></i> Export Summary CSV</button>
      </div>
      <div class="settings-card">
        <div style="font-size:13px;font-weight:600;margin-bottom:4px"><i class="fa fa-cloud-arrow-up" style="color:var(--success)"></i> Restore / Import Data</div>
        <div style="font-size:11px;color:var(--t3);margin-bottom:12px">Upload file backup JSON untuk memulihkan data. Data saat ini akan ditimpa.</div>
        <div id="drop-zone" style="border:2px dashed var(--border2);border-radius:8px;padding:24px;text-align:center;cursor:pointer;transition:.2s"
          ondragover="event.preventDefault();this.style.borderColor='var(--accent)'" ondragleave="this.style.borderColor='var(--border2)'" ondrop="handleDrop(event)" onclick="document.getElementById('restore-file').click()">
          <i class="fa fa-upload" style="font-size:24px;color:var(--t3);margin-bottom:8px;display:block"></i>
          <div style="font-size:12px;color:var(--t3)">Drop file JSON di sini atau klik untuk pilih</div>
        </div>
        <input type="file" id="restore-file" accept=".json" style="display:none" onchange="handleRestore(this.files[0])">
      </div>
    </div>
    <div>
      <div class="settings-card">
        <div style="font-size:13px;font-weight:600;margin-bottom:10px"><i class="fa fa-circle-info" style="color:var(--accent)"></i> Status Data</div>
        ${[['KPI (dari Program)',DB.kpis.length],['Program Kerja',DB.programs.length],['Risiko',DB.risks.length],['EWS Alert',DB.ews.length],['Pengadaan PO',DB.procurement.length],['Asset',DB.assets.length],['Temuan Audit',DB.audit.length],['Lisensi/SOP/Sertifikat',DB.licenses.length],['Units',DB.units.length],['Divisi',DB.divisions.length],['Users',DB.users.length]].map(([l,v])=>`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span style="font-size:12px;color:var(--t2)">${l}</span><span style="font-size:12px;font-weight:600;color:var(--accent)">${v} record</span></div>`).join('')}
      </div>
      <div class="settings-card">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px"><i class="fa fa-tag" style="color:var(--purple)"></i> Versi Aplikasi</div>
        <div style="font-size:11px;color:var(--t3);line-height:1.8">DIROPS MONITORING v2.0<br>Direktorat Operasi<br>PT Angkasa Pura Aviasi<br>Build: ${new Date().toLocaleDateString('id-ID')}</div>
      </div>
      <div class="settings-card" style="border-color:${fbConnected?'rgba(34,197,94,.3)':getFirebaseConfig()?'rgba(255,59,59,.3)':'rgba(100,100,100,.3)'}">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">
          <i class="fa fa-cloud" style="color:${fbConnected?'var(--success)':getFirebaseConfig()?'var(--danger)':'var(--t3)'}"></i>
          Status Firebase &nbsp;
          <span class="badge ${fbConnected?'badge-green':getFirebaseConfig()?'badge-red':'badge-blue'}">${fbConnected?'Terhubung':getFirebaseConfig()?'Terputus':'Belum dikonfigurasi'}</span>
        </div>
        ${fbConnected?`
          <div style="font-size:11px;color:var(--t2);margin-bottom:10px">Data tersinkronisasi ke cloud. Semua device yang menggunakan config yang sama akan mendapatkan data terbaru.</div>
          <button class="btn btn-danger" onclick="disconnectAndResetFirebase()" style="width:100%;justify-content:center"><i class="fa fa-plug-circle-xmark"></i> Putuskan Firebase</button>
        `:getFirebaseConfig()?`
          <div style="font-size:11px;color:var(--warn);margin-bottom:8px"><i class="fa fa-triangle-exclamation"></i> Config ada tapi tidak terhubung. Periksa koneksi internet atau config Firebase Anda.</div>
          <button class="btn btn-danger" onclick="disconnectAndResetFirebase()" style="width:100%;justify-content:center;margin-bottom:6px"><i class="fa fa-trash"></i> Hapus Config & Kembali Offline</button>
          <button class="btn btn-primary" onclick="retryFirebase()" style="width:100%;justify-content:center"><i class="fa fa-rotate"></i> Coba Hubungkan Ulang</button>
        `:`
          <div style="font-size:11px;color:var(--t3);margin-bottom:10px">Saat ini data hanya tersimpan di browser ini. Masukkan config Firebase agar data tersinkronisasi ke semua device.</div>
          <button class="btn btn-primary" onclick="openFirebaseSetup()" style="width:100%;justify-content:center"><i class="fa fa-plug"></i> Setup Firebase Sekarang</button>
        `}
      </div>
      <div class="settings-card">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px"><i class="fa fa-database" style="color:var(--accent)"></i> Penyimpanan Lokal</div>
        ${(()=>{
          try{
            const raw=localStorage.getItem(LS_KEY);
            if(!raw) return '<div style="font-size:11px;color:var(--t3)">Belum ada cache lokal.</div>';
            const saved=JSON.parse(raw);
            const savedAt=saved._saved?new Date(saved._saved).toLocaleString('id-ID'):'—';
            return `<div style="font-size:11px;color:var(--t2);line-height:2">Cache lokal tersedia &nbsp;<span style="color:var(--success)">✓</span><br>Terakhir: <strong>${savedAt}</strong><br>Ukuran: <strong>${Math.round(raw.length/1024)} KB</strong></div>`;
          }catch(e){return '';}
        })()}
        <button class="btn btn-danger" onclick="clearLocalStorage()" style="width:100%;justify-content:center;margin-top:8px"><i class="fa fa-rotate-left"></i> Reset ke Data Awal</button>
      </div>
    </div>
  </div>
  <div class="panel">
    <div class="panel-hd"><div class="panel-title"><i class="fa fa-clipboard-list"></i> Kelola Tipe Audit</div><button class="btn btn-primary btn-sm" onclick="addAuditType()"><i class="fa fa-plus"></i> Tambah</button></div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${DB.auditTypes.map(t=>`<div style="display:flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid var(--border2);border-radius:16px;padding:4px 12px"><span style="font-size:11px">${t}</span><button class="btn btn-sm btn-danger" style="padding:1px 5px;border:none;opacity:.5" onclick="removeAuditType('${t}')"><i class="fa fa-xmark"></i></button></div>`).join('')}
    </div>
  </div>`;
}
function addAuditType(){const name=prompt('Nama tipe audit baru:');if(!name||DB.auditTypes.includes(name))return;DB.auditTypes.push(name);renderSettings();}
function removeAuditType(t){if(DB.audit.some(a=>a.type===t)){alert('Tipe masih digunakan');return;}DB.auditTypes=DB.auditTypes.filter(x=>x!==t);renderSettings();}

// Firebase setup functions defined below renderSettings

function openFirebaseSetup(){
  document.getElementById('modal-title').textContent = 'Setup Firebase Realtime Database';
  document.getElementById('modal-body').innerHTML = `
    <div style="background:rgba(26,140,255,.06);border:1px solid rgba(26,140,255,.25);border-radius:8px;padding:12px 14px;margin-bottom:16px;font-size:11px;line-height:1.8;color:var(--t2)">
      <div style="font-weight:700;color:var(--accent);margin-bottom:6px"><i class="fa fa-circle-info"></i> Cara mendapatkan Firebase Config:</div>
      <ol style="padding-left:16px;display:flex;flex-direction:column;gap:3px">
        <li>Buka <strong>console.firebase.google.com</strong> → buat project baru (gratis)</li>
        <li>Klik ikon web (<strong>&lt;/&gt;</strong>) → daftarkan app → salin <code>firebaseConfig</code></li>
        <li>Di menu kiri: <strong>Build → Realtime Database</strong> → Create database → pilih region → <strong>Start in test mode</strong></li>
        <li>Paste config di bawah ini lalu klik Simpan & Hubungkan</li>
      </ol>
    </div>

    <div style="font-size:11px;color:var(--t3);margin-bottom:8px">Paste objek <code>firebaseConfig</code> dari Firebase Console:</div>
    <textarea class="form-textarea" id="fb-config-raw" rows="9" placeholder='{
  "apiKey": "AIza...",
  "authDomain": "project-id.firebaseapp.com",
  "databaseURL": "https://project-id-default-rtdb.asia-southeast1.firebasedatabase.app",
  "projectId": "project-id",
  "storageBucket": "project-id.appspot.com",
  "messagingSenderId": "123456789",
  "appId": "1:123456789:web:abc..."
}'></textarea>
    <div id="fb-setup-error" style="color:var(--danger);font-size:11px;margin-top:6px;display:none"></div>

    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn btn-primary" style="flex:1" onclick="saveFirebaseSetup()"><i class="fa fa-plug"></i> Simpan & Hubungkan</button>
      <button class="btn" onclick="closeModalDirect()">Batal</button>
    </div>`;
  openModalDirect();
}

async function saveFirebaseSetup(){
  const raw = document.getElementById('fb-config-raw').value.trim();
  const errEl = document.getElementById('fb-setup-error');
  errEl.style.display = 'none';

  let cfg;
  try{
    // Support paste dengan atau tanpa "const firebaseConfig = "
    const jsonStr = raw.replace(/^.*?=\s*/,'').replace(/;?\s*$/,'');
    cfg = JSON.parse(jsonStr);
  }catch(e){
    errEl.textContent = 'Format JSON tidak valid. Pastikan Anda menyalin seluruh objek { ... }';
    errEl.style.display = 'block';
    return;
  }

  if(!cfg.apiKey || !cfg.databaseURL){
    errEl.textContent = 'Config tidak lengkap. Pastikan ada apiKey dan databaseURL.';
    errEl.style.display = 'block';
    return;
  }

  // Simpan config
  saveFirebaseConfig(cfg);

  // Init Firebase
  const ok = initFirebase(cfg);
  if(!ok){
    errEl.textContent = 'Gagal inisialisasi Firebase. Periksa kembali config Anda.';
    errEl.style.display = 'block';
    return;
  }

  // Upload data saat ini ke Firebase
  await saveToFirebase();
  closeModalDirect();
  updateConnectionBadge();
  renderSettings();
  alert('✅ Firebase berhasil terhubung! Data Anda kini tersinkronisasi ke cloud.');
}

async function retryFirebase(){
  const cfg = getFirebaseConfig();
  if(!cfg) return;
  const ok = initFirebase(cfg);
  if(ok){
    await loadFromFirebase();
    syncKPIsFromPrograms();
    renderSettings();
  } else {
    alert('Gagal terhubung. Periksa koneksi internet Anda.');
  }
}

function backupData(type){
  if(type==='json'){const data=JSON.stringify({...DB,_meta:{version:'2.0',exported:new Date().toISOString()}},null,2);const blob=new Blob([data],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`DIROPS_backup_${today()}.json`;a.click();URL.revokeObjectURL(url);}
  else{const rows=[['Module','Metrik','Nilai']];rows.push(['KPI','Total',DB.kpis.length],['KPI','Avg Realisasi',DB.kpis.length?Math.round(DB.kpis.reduce((s,k)=>s+k.real,0)/DB.kpis.length)+'%':'0%'],['Program','Total',DB.programs.length],['Program','On Track',DB.programs.filter(p=>p.status==='On Track').length],['Risk','Total',DB.risks.length],['Risk','High+Moderate to High',DB.risks.filter(r=>riskScore(r)>=16).length],['EWS','Aktif',DB.ews.filter(e=>!e.acked).length],['Audit','Open+Overdue',DB.audit.filter(a=>a.status!=='Completed'&&a.status!=='Close').length],['Lisensi','Expire Alerts',DB.licenses.filter(l=>l.status!=='Valid').length]);const csv=rows.map(r=>r.map(c=>`"${c}"`).join(',')).join('\n');const blob=new Blob([csv],{type:'text/csv'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`DIROPS_summary_${today()}.csv`;a.click();URL.revokeObjectURL(url);}
}
function handleDrop(e){e.preventDefault();document.getElementById('drop-zone').style.borderColor='var(--border2)';const file=e.dataTransfer.files[0];if(file)handleRestore(file);}
function handleRestore(file){if(!file||!file.name.endsWith('.json')){alert('File harus .json');return;}const reader=new FileReader();reader.onload=e=>{try{const data=JSON.parse(e.target.result);if(!data.programs&&!data.units){alert('Format tidak valid');return;}if(!confirm('Data saat ini akan ditimpa. Lanjutkan?'))return;Object.assign(DB,data);delete DB._meta;syncKPIsFromPrograms();autoCheckAuditOverdue();autoCheckLicenseStatus();scheduleSave();updateBadges();alert('✅ Data berhasil dipulihkan!');showView('dashboard');}catch(err){alert('Error: '+err.message);}};reader.readAsText(file);}

function exportData(){const rows=[['Module','Data','Count']];rows.push(['KPI','Total KPIs',DB.kpis.length],['EWS','Active Alerts',DB.ews.filter(e=>!e.acked).length],['Risk','Risks',DB.risks.length],['Asset','Assets',DB.assets.length],['Procurement','POs',DB.procurement.length],['Program','Programs',DB.programs.length],['Audit','Open Findings',DB.audit.filter(a=>a.status!=='Completed').length],['Lisensi','Expire Alerts',DB.licenses.filter(l=>l.status!=='Valid').length]);const csv=rows.map(r=>r.join(',')).join('\n');const blob=new Blob([csv],{type:'text/csv'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='DIROPS_export.csv';a.click();URL.revokeObjectURL(url);}

function openModalDirect(){document.getElementById('modal-overlay').classList.add('open');}
function closeModalDirect(){document.getElementById('modal-overlay').classList.remove('open');}
function closeModal(e){if(e.target===document.getElementById('modal-overlay'))closeModalDirect();}


// ════════════════════════════════════════════════
// STORAGE: Firebase Auth + Realtime Database
// ════════════════════════════════════════════════

// ── Firebase Config — ganti dengan config project Anda ──
const FIREBASE_CONFIG = {
  apiKey:            "PASTE_API_KEY_HERE",
  authDomain:        "dirops-monitoring-avi.firebaseapp.com",
  databaseURL:       "https://dirops-monitoring-avi-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "dirops-monitoring-avi",
  storageBucket:     "dirops-monitoring-avi.appspot.com",
  messagingSenderId: "PASTE_MESSAGING_SENDER_ID_HERE",
  appId:             "PASTE_APP_ID_HERE"
};

const FB_DATA_PATH = 'dirops/data';
let _fbApp      = null;
let _fbDb       = null;
let _fbAuth     = null;
let _apiConnected = false;

function _initFirebaseOnce(){
  if(_fbApp) return;
  try{
    _fbApp  = firebase.initializeApp(FIREBASE_CONFIG, 'dirops-main');
    _fbDb   = _fbApp.database();
    _fbAuth = _fbApp.auth();
    _fbDb.ref('.info/connected').on('value', snap=>{
      _apiConnected = !!snap.val();
      updateConnectionBadge();
    });
    // Realtime listener — sync data dari Firebase ke lokal
    _fbDb.ref(FB_DATA_PATH).on('value', snap=>{
      const remote = snap.val();
      if(!remote || !currentUser) return;
      const ts = remote._saved||'';
      if(DB._lastSave && ts === DB._lastSave) return;
      const d = {...remote}; delete d._saved;
      Object.assign(DB, d);
      DB._lastSave = ts;
      syncKPIsFromPrograms(); autoCheckAuditOverdue(); autoCheckLicenseStatus(); updateBadges();
      const rv={dashboard:renderDashboard,integrated:renderIntegrated,kpi:renderKPI,program:renderProgram,risk:renderRisk,procurement:renderProcurement,asset:renderAsset,audit:renderAudit,license:renderLicense,units:renderUnits,users:renderUsers,settings:renderSettings};
      if(rv[currentView]){destroyCharts();rv[currentView]();}
    });
  }catch(e){ console.error('Firebase init error:',e); }
}

function getSession(){ try{ return JSON.parse(sessionStorage.getItem(SESSION_KEY)||'null'); }catch(e){ return null; } }
function setSession(u){ sessionStorage.setItem(SESSION_KEY, JSON.stringify(u)); }
function clearSession(){ sessionStorage.removeItem(SESSION_KEY); }
function getStoredToken(){ return sessionStorage.getItem('dirops_token')||null; }
function setStoredToken(t){ if(t) sessionStorage.setItem('dirops_token',t); else sessionStorage.removeItem('dirops_token'); }

async function doLoginAPI(email, pass){
  _initFirebaseOnce();
  try{
    const cred = await _fbAuth.signInWithEmailAndPassword(email, pass);
    const fbUid = cred.user.uid;
    // Load data dari Firebase untuk cari profil user
    const snap = await _fbDb.ref(FB_DATA_PATH).once('value');
    const remote = snap.val();
    if(remote){ const d={...remote}; delete d._saved; Object.assign(DB,d); DB._lastSave=remote._saved||''; }
    ensureAdminUser();
    const userProfile = DB.users.find(u=>u.email.toLowerCase()===email.toLowerCase()&&(u.status||'Active')!=='Inactive');
    if(!userProfile) return {success:false, error:'Akun tidak ditemukan di sistem. Hubungi Administrator.'};
    // Update last login
    userProfile.last = new Date().toLocaleString('id-ID',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
    saveToServer();
    const userData = {id:userProfile.id,name:userProfile.name,email:userProfile.email,role:userProfile.role,unit:userProfile.unit,isAdmin:!!userProfile.isAdmin};
    setStoredToken(fbUid);
    return {success:true, token:fbUid, user:userData};
  }catch(e){
    const msg = {
      'auth/user-not-found'  : 'Email tidak terdaftar di sistem autentikasi.',
      'auth/wrong-password'  : 'Password salah.',
      'auth/invalid-email'   : 'Format email tidak valid.',
      'auth/too-many-requests': 'Terlalu banyak percobaan. Coba lagi beberapa saat.',
      'auth/invalid-credential': 'Email atau password salah.',
    }[e.code] || ('Login gagal: ' + (e.message||e.code));
    return {success:false, error:msg};
  }
}

async function doLogoutAPI(){
  try{ if(_fbAuth) await _fbAuth.signOut(); }catch(e){}
  setStoredToken(null);
}
let _dataVersion = null; // hash dari data yang terakhir diload/disimpan

async function loadFromServer(){
  _initFirebaseOnce();
  const t=getStoredToken(); if(!t) return false;
  try{
    const snap = await _fbDb.ref(FB_DATA_PATH).once('value');
    const remote = snap.val();
    if(!remote) return false;
    const d={...remote}; delete d._saved;
    Object.assign(DB,d);
    DB._lastSave = remote._saved||'';
    _dataVersion = DB._lastSave;
    _apiConnected = true;
    return true;
  }catch(e){ _apiConnected=false; return false; }
}

async function saveToServer(){
  _initFirebaseOnce();
  if(!_fbDb||!getStoredToken()){ _apiConnected=false; return false; }
  try{
    const ts = new Date().toISOString();
    DB._lastSave = ts;
    const payload={...DB}; delete payload.kpis;
    payload._saved = ts;
    await _fbDb.ref(FB_DATA_PATH).set(payload);
    _dataVersion = ts;
    _apiConnected = true;
    return true;
  }catch(e){ _apiConnected=false; return false; }
}

function showMergeNotification(msg){
  const el=document.getElementById('save-indicator'); if(!el) return;
  el.innerHTML='<i class="fa fa-code-merge" style="color:var(--warn)"></i> Data digabungkan';
  el.style.color='var(--warn)'; el.style.opacity='1';
  clearTimeout(el._t);
  el._t=setTimeout(()=>{ el.style.opacity='0'; },5000);
  console.info('Merge:', msg);
}
function saveToLocalStorage(){ try{ localStorage.setItem(LS_KEY,JSON.stringify({...DB,_saved:new Date().toISOString()})); }catch(e){} }
function loadFromLocalStorage(){
  try{ const raw=localStorage.getItem(LS_KEY); if(!raw) return false; const s=JSON.parse(raw); if(!s.programs||!s.units) return false; delete s._saved; Object.assign(DB,s); return true; }
  catch(e){ return false; }
}
function scheduleSave(){
  clearTimeout(_saveTimer);
  _saveTimer=setTimeout(async()=>{ saveToLocalStorage(); const ok=await saveToServer(); showSaveIndicator(ok); },600);
}
function showSaveIndicator(ok){
  const el=document.getElementById('save-indicator'); if(!el) return;
  el.innerHTML=ok?'<i class="fa fa-database" style="color:var(--success)"></i> Tersimpan':'<i class="fa fa-hard-drive" style="color:var(--warn)"></i> Lokal';
  el.style.opacity='1'; clearTimeout(el._t); el._t=setTimeout(()=>{el.style.opacity='0';},3000);
}
function updateConnectionBadge(){
  const el=document.getElementById('fb-status'); if(!el) return;
  el.innerHTML=_apiConnected?'<i class="fa fa-database" style="color:var(--success)"></i>':'<i class="fa fa-database" style="color:var(--t3)"></i>';
  el.title=_apiConnected?'Database MySQL terhubung':'Database tidak terhubung';
}
function clearLocalStorage(){ if(!confirm('Reset semua data ke kondisi awal?')) return; localStorage.removeItem(LS_KEY); location.reload(); }
function openFirebaseSetup(){ alert('Aplikasi menggunakan MySQL. Tidak perlu setup Firebase.'); }
function saveFirebaseSetup(){}
function retryFirebase(){}
function disconnectAndResetFirebase(){}
function getFirebaseConfig(){ return null; }

// ════ AUTH ════
function ensureAdminUser(){
  const existing=DB.users&&DB.users.find(u=>u.isAdmin===true);
  if(!existing){ if(!DB.users) DB.users=[]; DB.users.unshift({id:'admin',name:'Administrator',email:'safety@avi.id',role:'Admin',unit:'All Units',phone:'',last:'Today',status:'Active',password:'admin123',isAdmin:true}); }
}
function getPerm(mod){ if(!currentUser) return 0; if(currentUser.isAdmin) return 2; const p=DB.rolePermissions&&DB.rolePermissions[currentUser.role]||{}; return p[mod]||0; }
function canView(mod){ return getPerm(mod)>=1; }
function canEdit(mod){ return getPerm(mod)>=2; }
function buildNavFromPermissions(){
  document.querySelectorAll('.nav-item[data-view]').forEach(el=>{
    const v=el.dataset.view, mod=VIEW_MODULE_MAP[v]||v, p=getPerm(mod);
    el.style.display=p===0?'none':'flex';
    const eb=el.querySelector('.view-only-badge'); if(eb) eb.remove();
    if(p===1){ const vb=document.createElement('span'); vb.className='view-only-badge'; vb.style.cssText='margin-left:auto;font-size:8px;color:var(--warn);background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);border-radius:4px;padding:1px 4px'; vb.textContent='View'; el.appendChild(vb); }
  });
}
function showApp(){
  document.getElementById('login-screen').style.display='none';
  document.querySelector('.sidebar').style.visibility='';
  document.querySelector('.main').style.visibility='';
  const ini=(currentUser.name||'').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('sidebar-av').textContent=ini;
  document.getElementById('sidebar-name').textContent=currentUser.name;
  document.getElementById('sidebar-role').textContent=currentUser.isAdmin?'Administrator':currentUser.role+' · '+currentUser.unit;
  buildNavFromPermissions();
}
async function doLogin(){
  const email=document.getElementById('login-email').value.trim().toLowerCase();
  const pass=document.getElementById('login-pass').value;
  const errEl=document.getElementById('login-error');
  const btn=document.querySelector('#login-screen .btn-primary');
  errEl.style.display='none';
  if(!email||!pass){ errEl.textContent='Email dan kata sandi wajib diisi.'; errEl.style.display='block'; return; }
  if(btn){ btn.disabled=true; btn.innerHTML='<i class="fa fa-spinner fa-spin"></i> Memproses...'; }
  const result=await doLoginAPI(email,pass);
  if(btn){ btn.disabled=false; btn.innerHTML='<i class="fa fa-arrow-right-to-bracket"></i> Masuk'; }
  if(result.success){
    setStoredToken(result.token); _sessionToken=result.token;
    currentUser=result.user; setSession(currentUser);
    await loadFromServer(); syncKPIsFromPrograms(); autoCheckAuditOverdue(); autoCheckLicenseStatus(); updateBadges(); updateConnectionBadge();
    showApp(); showView('dashboard');
  } else {
    ensureAdminUser();
    const user=DB.users.find(u=>u.email.toLowerCase()===email&&u.status!=='Inactive');
    if(user&&(user.password||'')===pass){
      currentUser={id:user.id,name:user.name,email:user.email,role:user.role,unit:user.unit,isAdmin:!!user.isAdmin};
      setSession(currentUser); showApp(); showView('dashboard');
    } else {
      errEl.textContent=result.error||'Login gagal. Periksa email dan kata sandi.'; errEl.style.display='block';
    }
  }
}
async function doLogout(){
  if(!confirm('Apakah Anda yakin ingin keluar?')) return;
  await doLogoutAPI(); clearSession(); currentUser=null;
  document.getElementById('login-email').value='';
  document.getElementById('login-pass').value='';
  document.getElementById('login-error').style.display='none';
  document.getElementById('login-screen').style.display='flex';
  document.querySelector('.sidebar').style.visibility='hidden';
  document.querySelector('.main').style.visibility='hidden';
}
function toggleLoginPw(){
  const inp=document.getElementById('login-pass'); const eye=document.getElementById('pw-eye');
  if(inp.type==='password'){inp.type='text';eye.className='fa fa-eye-slash';}else{inp.type='password';eye.className='fa fa-eye';}
}

// ════ FILTER UNIVERSAL ════
const moduleFilters={};
function getFilter(mod){ if(!moduleFilters[mod]) moduleFilters[mod]={unit:'semua',divisi:'semua',tahun:'semua',bulan:'semua',groupBy:'none'}; return moduleFilters[mod]; }
const _reFns={Kpi:()=>renderKPI(),Program:()=>renderProgram(),Risk:()=>renderRisk(),Asset:()=>renderAsset(),Audit:()=>renderAudit(),License:()=>renderLicense()};
function buildFilterBar(mod, items, getDateFn, getUnitIdFn){
  const f=getFilter(mod);
  const mn=['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const years=[...new Set(items.map(x=>{const d=getDateFn(x);return d?d.substring(0,4):''}).filter(Boolean))].sort().reverse();
  let filtered=items.filter(x=>{
    const uid=getUnitIdFn(x); const u=DB.units.find(z=>z.id===uid);
    if(f.unit!=='semua'&&uid!==f.unit) return false;
    if(f.divisi!=='semua'&&(!u||u.divisi!==f.divisi)) return false;
    const d=getDateFn(x);
    if(f.tahun!=='semua'&&(!d||!d.startsWith(f.tahun))) return false;
    if(f.bulan!=='semua'&&(!d||d.substring(5,7)!==f.bulan)) return false;
    return true;
  });
  const hasFilter=f.unit!=='semua'||f.divisi!=='semua'||f.tahun!=='semua'||f.bulan!=='semua'||f.groupBy!=='none';
  const filtUnits=f.divisi==='semua'?DB.units:DB.units.filter(u=>u.divisi===f.divisi);
  const bar=`<div class="panel" style="padding:10px 14px;margin-bottom:4px">
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px">
      <span style="font-size:10px;font-weight:700;color:var(--t3)"><i class="fa fa-filter"></i> FILTER:</span>
      <select class="form-select" style="padding:4px 8px;font-size:11px;width:auto" onchange="getFilter('${mod}').divisi=this.value;getFilter('${mod}').unit='semua';(_reFns['${mod}']||function(){})()">
        <option value="semua"${f.divisi==='semua'?' selected':''}>Semua Divisi</option>
        ${DB.divisions.map(d=>`<option value="${d}"${f.divisi===d?' selected':''}>${d}</option>`).join('')}
      </select>
      <select class="form-select" style="padding:4px 8px;font-size:11px;width:auto" onchange="getFilter('${mod}').unit=this.value;(_reFns['${mod}']||function(){})()">
        <option value="semua">Semua Unit</option>
        ${filtUnits.map(u=>`<option value="${u.id}"${f.unit===u.id?' selected':''}>${u.name}</option>`).join('')}
      </select>
      <select class="form-select" style="padding:4px 8px;font-size:11px;width:auto" onchange="getFilter('${mod}').tahun=this.value;(_reFns['${mod}']||function(){})()">
        <option value="semua">Semua Tahun</option>
        ${years.map(y=>`<option value="${y}"${f.tahun===y?' selected':''}>${y}</option>`).join('')}
      </select>
      <select class="form-select" style="padding:4px 8px;font-size:11px;width:auto" onchange="getFilter('${mod}').bulan=this.value;(_reFns['${mod}']||function(){})()">
        <option value="semua">Semua Bulan</option>
        ${['01','02','03','04','05','06','07','08','09','10','11','12'].map((m,i)=>`<option value="${m}"${f.bulan===m?' selected':''}>${mn[i]}</option>`).join('')}
      </select>
      <div style="margin-left:auto;display:flex;align-items:center;gap:6px">
        <span style="font-size:10px;font-weight:700;color:var(--t3)"><i class="fa fa-layer-group"></i> KELOMPOKKAN:</span>
        <select class="form-select" style="padding:4px 8px;font-size:11px;width:auto" onchange="getFilter('${mod}').groupBy=this.value;(_reFns['${mod}']||function(){})()">
          <option value="none"${f.groupBy==='none'?' selected':''}>— Tidak dikelompokkan</option>
          <option value="divisi"${f.groupBy==='divisi'?' selected':''}>Divisi</option>
          <option value="unit"${f.groupBy==='unit'?' selected':''}>Unit</option>
          <option value="tahun"${f.groupBy==='tahun'?' selected':''}>Tahun</option>
          <option value="bulan"${f.groupBy==='bulan'?' selected':''}>Bulan</option>
        </select>
        ${hasFilter?`<button class="btn btn-sm btn-danger" onclick="moduleFilters['${mod}']={unit:'semua',divisi:'semua',tahun:'semua',bulan:'semua',groupBy:'none'};(_reFns['${mod}']||function(){})()"><i class="fa fa-rotate-left"></i> Reset</button>`:''}
      </div>
    </div>
    ${filtered.length!==items.length?`<div style="margin-top:6px;padding:5px 10px;background:rgba(26,140,255,.08);border-radius:6px;font-size:11px;color:var(--accent)"><i class="fa fa-filter"></i> Menampilkan <strong>${filtered.length}</strong> dari ${items.length} data</div>`:''}
  </div>`;
  function applyGroup(arr,by){
    if(by==='none') return {'__all__':arr};
    const g={};
    arr.forEach(x=>{
      let key; const uid=getUnitIdFn(x); const u=DB.units.find(z=>z.id===uid);
      if(by==='divisi') key=u?u.divisi:'—';
      else if(by==='unit') key=u?u.name:'—';
      else if(by==='tahun'){const d=getDateFn(x);key=d?d.substring(0,4):'—';}
      else if(by==='bulan'){const d=getDateFn(x);key=d?mn[parseInt(d.substring(5,7))-1]+' '+d.substring(0,4):'—';}
      if(!g[key])g[key]=[];g[key].push(x);
    });
    return Object.fromEntries(Object.entries(g).sort((a,b)=>a[0].localeCompare(b[0])));
  }
  return {bar, filtered, groups:applyGroup(filtered,f.groupBy), showHeader:f.groupBy!=='none'};
}
function renderGroupHeader(name,count){
  return `<div style="display:flex;align-items:center;gap:8px;margin:14px 0 6px;padding-left:10px;border-left:3px solid var(--accent)">
    <div style="font-size:13px;font-weight:700;color:var(--t1)">${name}</div>
    <span class="badge badge-blue">${count} item</span>
  </div>`;
}

// ════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════
(async function(){
  document.querySelector('.sidebar').style.visibility='hidden';
  document.querySelector('.main').style.visibility='hidden';
  try{ localStorage.removeItem('ikera_v2_data'); localStorage.removeItem('ikera_v3_data'); }catch(e){}
  loadFromLocalStorage();
  ensureAdminUser();
  syncKPIsFromPrograms(); autoCheckAuditOverdue(); autoCheckLicenseStatus(); updateBadges(); updateConnectionBadge();
  const token=getStoredToken(); const sess=getSession();
  if(token&&sess&&sess.email){
    const loaded=await loadFromServer();
    if(loaded){ syncKPIsFromPrograms(); autoCheckAuditOverdue(); autoCheckLicenseStatus(); updateBadges(); }
    const u=DB.users.find(x=>x.email.toLowerCase()===sess.email.toLowerCase()&&x.status!=='Inactive');
    if(u){ currentUser={id:u.id,name:u.name,email:u.email,role:u.role,unit:u.unit,isAdmin:!!u.isAdmin}; updateConnectionBadge(); showApp(); showView('dashboard'); }
    else{ setStoredToken(null); clearSession(); }
  }
  if(window.innerWidth<=768) document.getElementById('sidebar-toggle').style.display='';
  window.addEventListener('resize',()=>{ document.getElementById('sidebar-toggle').style.display=window.innerWidth<=768?'':'none'; });
  window.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='hidden'){ saveToLocalStorage(); saveToServer(); } });
  window.addEventListener('beforeunload', saveToLocalStorage);
  setTimeout(()=>{ const e=document.getElementById('login-email'); if(e&&!currentUser) e.focus(); },200);
})();
