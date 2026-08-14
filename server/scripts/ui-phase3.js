// §3 · Daily entry — driven through the real UI in a visible Edge window.
const { chromium } = require('playwright');
const path = require('path');

const SHOTS = __dirname;
const BASE  = 'http://localhost:5000';
const out   = [];

function rec(id, desc, ok, note) {
  out.push({ id, desc, ok, note });
  console.log(`  ${ok ? '[x]' : '[o]'} ${id.padEnd(6)} ${desc}${note ? '\n         ' + note : ''}`);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: false, slowMo: 550 });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();

  // Catch any dialog — the XSS probe relies on alert() never firing.
  let xssFired = false;
  page.on('dialog', async d => { xssFired = true; await d.dismiss(); });

  const shot = async n => page.screenshot({ path: path.join(SHOTS, `p3-${n}.png`) });

  // Navigating to Submit intermittently leaves the page on its loading spinner:
  // rdSubmit's first GET returns but the second never fires. Retry by calling the
  // render directly, and count how often the plain click was not enough — that
  // count is itself a finding, tracked separately from the §3 results.
  let navRetries = 0, navAttempts = 0;
  async function gotoSubmit() {
    navAttempts++;
    await page.evaluate(() => sp('submit'));
    try {
      await page.waitForSelector('#tf_title', { state: 'visible', timeout: 6000 });
      return;
    } catch {
      navRetries++;
      await page.evaluate(() => rdSubmit());
      await page.waitForSelector('#tf_title', { state: 'visible', timeout: 10000 });
    }
  }

  // ── Login ───────────────────────────────────────────────────────────
  await page.goto(BASE);
  await page.fill('#lu', 'qa.employee.a');
  await page.fill('#lp', 'QAtest123');
  await shot('01-login');
  await page.click('#loginBtn');
  await page.waitForSelector('#appWrap', { state: 'visible', timeout: 15000 });
  await wait(1200);
  await shot('02-dashboard');
  console.log('\nlogged in as QA Employee A\n');

  // ── 3.9 · required fields ───────────────────────────────────────────
  await gotoSubmit();
  await wait(600);

  await page.fill('#tf_title', '');
  await page.fill('#tf_proj', '');
  await page.click('#submitBtn');
  await wait(900);
  let toast = await page.locator('.toast, [class*=toast]').first().innerText().catch(() => '');
  await shot('03-required-fields');
  rec('3.9', 'Empty title + project → rejected', /required|validation/i.test(toast),
      `toast: ${toast.replace(/\s+/g, ' ').trim().slice(0, 90)}`);

  // Title only, project still blank — the second half of the check.
  await page.fill('#tf_title', 'Only a title');
  await page.click('#submitBtn');
  await wait(900);
  const stillOnForm = await page.locator('#tf_title').isVisible();
  rec('3.9b', 'Title without project → still rejected', stillOnForm);

  // ── 3.10 · hours bounds ─────────────────────────────────────────────
  await page.fill('#tf_hrs', '30');
  const hrsValid = await page.evaluate(() => document.getElementById('tf_hrs').checkValidity());
  rec('3.10', 'hours = 30 → outside the 0–24 range', !hrsValid,
      hrsValid ? 'input reports VALID despite max=24' : 'input max=24 flags it invalid');
  await page.fill('#tf_hrs', '-5');
  const negValid = await page.evaluate(() => document.getElementById('tf_hrs').checkValidity());
  rec('3.10b', 'hours = -5 → rejected', !negValid);
  await page.fill('#tf_hrs', '7.5');

  // ── 3.1 · submit a real daily update ────────────────────────────────
  await page.fill('#tf_title', 'Container clearance follow-up');
  await page.fill('#tf_proj', 'Jebel Ali Ops');
  await page.fill('#tf_desc', 'Chased three pending BOEs with the broker and cleared two.');
  await page.selectOption('#tf_status', 'in-progress');
  await page.selectOption('#tf_pri', 'high');
  await page.fill('#tf_next', 'Close the third BOE and start the Sharjah manifest.');
  await shot('04-filled-form');

  await page.click('#submitBtn');
  await wait(2000);
  await shot('05-after-submit');

  const listText = await page.locator('body').innerText();
  rec('3.1', 'Daily update submitted and visible in the list',
      listText.includes('Container clearance follow-up'));

  // ── 3.2 · second submission the same day ────────────────────────────
  // The UI re-renders as an edit form, so the server guard is probed directly
  // with the page's own session — a UI that merely hides the button would
  // otherwise read as a pass.
  const dup = await page.evaluate(async () => {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 Authorization: 'Bearer ' + localStorage.getItem('tf_token') },
      body: JSON.stringify({ title: 'Duplicate attempt', project: 'QA', status: 'completed' }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  });
  rec('3.2', 'Second submission the same day → 400 with a clear message',
      dup.status === 400 && /already submitted/i.test(dup.body?.message || ''),
      `${dup.status} — "${dup.body?.message || ''}"`);

  await gotoSubmit();
  await wait(800);
  const btnLabel = await page.locator('#submitBtn').innerText();
  await shot('06-edit-mode');
  rec('3.2b', 'Revisiting the form shows Update, not a second Submit',
      /update/i.test(btnLabel), `button reads "${btnLabel.trim()}"`);

  // ── 3.3 + 3.15 · edit, with Arabic text ─────────────────────────────
  const arabic = 'متابعة تخليص الحاويات — ميناء جبل علي';
  await page.fill('#tf_title', arabic);
  await page.fill('#tf_desc', 'تم تخليص شحنتين من أصل ثلاث.');
  await page.click('#submitBtn');
  await wait(2000);
  await shot('07-arabic-saved');

  const afterEdit = await page.locator('body').innerText();
  rec('3.3', 'Edit persists, no duplicate row created',
      afterEdit.includes(arabic) && !afterEdit.includes('Container clearance follow-up'));
  rec('3.15', 'Arabic text stored and displayed correctly',
      afterEdit.includes(arabic));

  const rowCount = await page.evaluate(async () => {
    const r = await fetch('/api/tasks?date=' + new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' }), {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('tf_token') },
    });
    return (await r.json()).tasks.length;
  });
  rec('3.3b', 'Exactly one row exists for today after editing', rowCount === 1,
      `rows today: ${rowCount}`);

  // ── 3.16 · XSS ──────────────────────────────────────────────────────
  const payload = '<img src=x onerror=alert(1)>';
  await gotoSubmit();
  await wait(600);
  await page.fill('#tf_title', payload);
  await page.click('#submitBtn');
  await wait(2200);
  await shot('08-xss-list');

  const injected = await page.evaluate(() =>
    document.querySelectorAll('img[src="x"], img[onerror]').length);
  const shownLiteral = (await page.locator('body').innerText()).includes(payload);

  rec('3.16', 'XSS payload in the title is escaped, not executed',
      !xssFired && injected === 0,
      `alert fired: ${xssFired} · injected <img> nodes: ${injected} · shown as literal text: ${shownLiteral}`);

  // Restore something sane so the fixture isn't left holding a payload.
  await gotoSubmit();
  await page.fill('#tf_title', 'Container clearance follow-up');
  await page.click('#submitBtn');
  await wait(1800);
  await shot('09-restored');

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Submit-page navigation: ${navRetries}/${navAttempts} needed a forced re-render`);
  const pass = out.filter(r => r.ok).length;
  console.log(`${pass}/${out.length} passed`);
  const fails = out.filter(r => !r.ok);
  if (fails.length) {
    console.log('\nFAILED:');
    fails.forEach(f => console.log(`  ${f.id}  ${f.desc}${f.note ? '\n        ' + f.note : ''}`));
  }

  await wait(2500);
  await browser.close();
})().catch(async e => { console.error('\nERR', e.message); process.exit(1); });
