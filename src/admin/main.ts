// Admin dashboard: login, counters, table, filters, capacity form, 15 s polling (plan §7).
import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/admin.css';
import { createClient, type PostgrestError } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../shared/config';
import { GENDER_LABEL, normalizePhone, type Gender } from '../shared/phone';

interface Row {
  id: number;
  gender: Gender;
  attendanceNumber: number | null;
  fullName: string;
  phone: string;
  faculty: string;
  university: string;
  status: 'confirmed' | 'waiting';
  waitingPosition: number | null;
  createdAt: string;
  confirmedAt: string | null;
}

interface Pool {
  capacity: number;
  confirmed: number;
  waiting: number;
}

interface Dashboard {
  male: Pool;
  female: Pool;
  confirmed: number;
  waiting: number;
  total: number;
  registrations: Row[];
}

type CapacityResult =
  | { result: 'ok'; capacity: number; promotedCount: number; promoted: { attendanceNumber: number }[] }
  | { result: 'invalid'; reason: 'below_confirmed' | 'out_of_range' | 'invalid_gender'; confirmed?: number };

type DeleteResult =
  | { result: 'ok'; deletedId: number; promoted: { id: number; fullName: string; attendanceNumber: number } | null }
  | { result: 'not_found' };

const POLL_MS = 15_000;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const loginSection = $('login-section');
const dashboardSection = $('dashboard-section');
const logoutBtn = $<HTMLButtonElement>('logout-btn');
const loginForm = $<HTMLFormElement>('login-form');
const loginAlert = $('login-alert');
const loginBtn = $<HTMLButtonElement>('login-btn');
const dashAlert = $('dash-alert');
const capacityForm = $<HTMLFormElement>('capacity-form');
const capacityGender = $<HTMLSelectElement>('capacity-gender');
const capacityInput = $<HTMLInputElement>('capacity');
const capacityBtn = $<HTMLButtonElement>('capacity-btn');
const capacityResult = $('capacity-result');
const statusFilter = $<HTMLSelectElement>('status-filter');
const genderFilter = $<HTMLSelectElement>('gender-filter');
const searchInput = $<HTMLInputElement>('search');
const rowsEl = $('rows');

const dateFmt = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Africa/Cairo',
});

let data: Dashboard | null = null;
let pollTimer: number | undefined;
let capacityDirty = false;

function show(el: HTMLElement, message: string | null): void {
  el.textContent = message ?? '';
  el.hidden = !message;
}

function isNotAdmin(err: PostgrestError): boolean {
  return err.code === '42501';
}

// ---------- Views ----------
function showLogin(message: string | null = null): void {
  stopPolling();
  data = null;
  dashboardSection.hidden = true;
  logoutBtn.hidden = true;
  loginSection.hidden = false;
  show(loginAlert, message);
}

function showDashboard(): void {
  loginSection.hidden = true;
  dashboardSection.hidden = false;
  logoutBtn.hidden = false;
}

// ---------- Data ----------
async function refresh(): Promise<void> {
  const { data: result, error } = await supabase.rpc('admin_dashboard');
  if (error) {
    if (isNotAdmin(error)) {
      await supabase.auth.signOut();
      showLogin('الحساب ده مش من حسابات المسؤولين.');
      return;
    }
    showDashboard();
    show(dashAlert, 'مقدرناش نحدّث البيانات. هنحاول تاني تلقائيًا.');
    return;
  }
  show(dashAlert, null);
  data = result as Dashboard;
  showDashboard();
  render();
}

function startPolling(): void {
  stopPolling();
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, POLL_MS);
}

function stopPolling(): void {
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
  pollTimer = undefined;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pollTimer !== undefined) void refresh();
});

// ---------- Rendering ----------
function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function matches(row: Row, query: string, phoneQuery: string): boolean {
  if (!query) return true;
  if (row.fullName.toLowerCase().includes(query)) return true;
  return phoneQuery.length > 0 && row.phone.includes(phoneQuery);
}

function render(): void {
  if (!data) return;

  for (const g of ['male', 'female'] as const) {
    const pool = data[g];
    $(`count-${g}`).textContent = String(pool.confirmed);
    $(`capacity-${g}`).textContent = String(pool.capacity);
    $(`left-${g}`).textContent = String(Math.max(0, pool.capacity - pool.confirmed));
    $(`waiting-${g}`).textContent = String(pool.waiting);
  }
  $('count-confirmed').textContent = String(data.confirmed);
  $('count-waiting').textContent = String(data.waiting);
  $('count-total').textContent = String(data.total);

  const pool = data[capacityGender.value as Gender];
  if (!capacityDirty && document.activeElement !== capacityInput) {
    capacityInput.value = String(pool.capacity);
  }
  capacityInput.min = String(Math.max(1, pool.confirmed));

  const filter = statusFilter.value;
  const gFilter = genderFilter.value;
  const query = searchInput.value.trim().toLowerCase();
  const phoneQuery = /\d|[٠-٩]/.test(query) ? normalizePhone(query) : '';

  // Server order: confirmed boys, confirmed girls (by number), then waiting boys, waiting girls
  const rows = data.registrations.filter(
    (r) =>
      (filter === 'all' || r.status === filter) &&
      (gFilter === 'all' || r.gender === gFilter) &&
      matches(r, query, phoneQuery),
  );

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.append(
      cell(r.attendanceNumber != null ? String(r.attendanceNumber) : '—', 'num'),
      cell(GENDER_LABEL[r.gender]),
      cell(r.fullName),
      cell(r.phone, 'phone'),
      cell(r.faculty),
      cell(r.university),
    );
    const statusTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge badge-${r.status}`;
    badge.textContent = r.status === 'confirmed' ? 'مؤكد' : 'انتظار';
    statusTd.append(badge);
    tr.append(
      statusTd,
      cell(r.waitingPosition != null ? `#${r.waitingPosition}` : '—'),
      cell(dateFmt.format(new Date(r.createdAt))),
    );
    const actionTd = document.createElement('td');
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-danger btn-tiny';
    deleteBtn.textContent = 'حذف';
    deleteBtn.addEventListener('click', () => void deleteRow(r, deleteBtn));
    actionTd.append(deleteBtn);
    tr.append(actionTd);
    frag.append(tr);
  }
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = cell(data.total === 0 ? 'لسه مفيش تسجيلات.' : 'مفيش نتايج.');
    td.colSpan = 10;
    tr.append(td);
    frag.append(tr);
  }
  rowsEl.replaceChildren(frag);

  $('shown-count').textContent = `معروض ${rows.length} من ${data.total}`;
  $('last-updated').textContent = `آخر تحديث: ${dateFmt.format(new Date())}`;
}

statusFilter.addEventListener('change', render);
genderFilter.addEventListener('change', render);
searchInput.addEventListener('input', render);

// ---------- Delete ----------
async function deleteRow(row: Row, btn: HTMLButtonElement): Promise<void> {
  const pool = GENDER_LABEL[row.gender];
  const label = row.attendanceNumber != null ? `رقم ${row.attendanceNumber} ${pool}` : `من انتظار ال${pool}`;
  if (!window.confirm(`متأكد إنك عايز تحذف تسجيل "${row.fullName}" (${label})؟ مينفعش التراجع.`)) return;

  btn.disabled = true;
  const { data: res, error } = await supabase.rpc('delete_registration', { p_id: row.id });

  if (error) {
    btn.disabled = false;
    if (isNotAdmin(error)) {
      await supabase.auth.signOut();
      showLogin('الحساب ده مش من حسابات المسؤولين.');
      return;
    }
    show(dashAlert, 'حصلت مشكلة ومتحذفش التسجيل. حاول تاني.');
    return;
  }

  const result = res as DeleteResult;
  await refresh();
  if (result.result === 'not_found') {
    show(dashAlert, 'التسجيل ده اتحذف قبل كده.');
  } else if (result.promoted) {
    show(
      dashAlert,
      `اتحذف "${row.fullName}" — واتنقل "${result.promoted.fullName}" من الانتظار برقم ${result.promoted.attendanceNumber}.`,
    );
  } else {
    show(dashAlert, `اتحذف "${row.fullName}".`);
  }
}

// ---------- Capacity ----------
capacityInput.addEventListener('input', () => {
  capacityDirty = true;
});

capacityGender.addEventListener('change', () => {
  capacityDirty = false;
  show(capacityResult, null);
  render();
});

function setCapacityMessage(message: string, isError: boolean): void {
  capacityResult.classList.toggle('is-error', isError);
  show(capacityResult, message);
}

capacityForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = Number(capacityInput.value);
  if (!Number.isInteger(value) || value < 1) {
    setCapacityMessage('اكتب رقم صحيح أكبر من صفر.', true);
    return;
  }

  const gender = capacityGender.value as Gender;
  capacityBtn.disabled = true;
  const { data: res, error } = await supabase.rpc('set_capacity', { p_gender: gender, p_new_capacity: value });
  capacityBtn.disabled = false;

  if (error) {
    if (isNotAdmin(error)) {
      await supabase.auth.signOut();
      showLogin('الحساب ده مش من حسابات المسؤولين.');
      return;
    }
    setCapacityMessage('حصلت مشكلة ومتحفظتش السعة. حاول تاني.', true);
    return;
  }

  const result = res as CapacityResult;
  if (result.result === 'invalid') {
    setCapacityMessage(
      result.reason === 'below_confirmed'
        ? `مينفعش السعة تقل عن عدد المؤكدين (${result.confirmed}).`
        : 'الرقم ده مش مقبول.',
      true,
    );
  } else {
    const n = result.promotedCount;
    let message = `سعة ال${GENDER_LABEL[gender]} بقت ${result.capacity}`;
    if (n > 0) {
      const first = result.promoted[0].attendanceNumber;
      const last = result.promoted[n - 1].attendanceNumber;
      message += ` — اتنقل ${n} من قائمة الانتظار (${n === 1 ? `رقم ${first}` : `أرقام ${first}–${last}`})`;
    }
    setCapacityMessage(message, false);
    capacityDirty = false;
  }
  await refresh();
});

// ---------- Auth ----------
loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  show(loginAlert, null);
  loginBtn.disabled = true;
  loginBtn.querySelector<HTMLElement>('.spinner')!.hidden = false;

  const email = ($('email') as HTMLInputElement).value.trim();
  const password = ($('password') as HTMLInputElement).value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  loginBtn.disabled = false;
  loginBtn.querySelector<HTMLElement>('.spinner')!.hidden = true;

  if (error) {
    show(
      loginAlert,
      error.status === 429 ? 'محاولات كتير. استنى شوية وحاول تاني.' : 'البريد أو كلمة السر غلط.',
    );
    return;
  }
  ($('password') as HTMLInputElement).value = '';
  await refresh();
  if (loginSection.hidden) startPolling();
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  showLogin();
});

// ---------- Start ----------
void (async () => {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) {
    showLogin();
    return;
  }
  await refresh();
  if (loginSection.hidden) startPolling();
})();
