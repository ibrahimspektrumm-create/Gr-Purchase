/**
 * GR Purchase v3 — Firestore Seed Script
 * ════════════════════════════════════════════════════════════════
 * Run once after creating the Firebase project:
 *   node seed.js
 *
 * Requires:
 *   npm install firebase-admin
 *
 * Set your service account key path below, or set the env var:
 *   export GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

const admin = require('firebase-admin');
const path  = require('path');

/* ── CONFIG ── */
const PROJECT_ID       = 'gr-pur';
const SERVICE_KEY_PATH = './serviceAccountKey.json';  // ضع ملف الـ Service Account هنا

/* ── INIT ── */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: process.env.GOOGLE_APPLICATION_CREDENTIALS
      ? admin.credential.applicationDefault()
      : admin.credential.cert(require(path.resolve(SERVICE_KEY_PATH))),
    projectId: PROJECT_ID,
  });
}

const auth = admin.auth();
const db   = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* ── SEED DATA ── */
const BRANCHES = [
  { id: 'branch-01', name: 'المحل الأول',  city: 'برلين',      label: 'B1' },
  { id: 'branch-02', name: 'المحل الثاني', city: 'هامبورغ',    label: 'B2' },
  { id: 'branch-03', name: 'المحل الثالث', city: 'ميونخ',      label: 'B3' },
  { id: 'branch-04', name: 'المحل الرابع', city: 'فرانكفورت',  label: 'B4' },
];

const USERS = [
  {
    email:       'ahmed@spektrumm.de',
    password:    'ChangeMe@2025!',
    displayName: 'أحمد محمود',
    role:        'admin',
    branches:    ['branch-01', 'branch-02', 'branch-03', 'branch-04'],
  },
  {
    email:       'sara@spektrumm.de',
    password:    'ChangeMe@2025!',
    displayName: 'سارة علي',
    role:        'user',
    branches:    ['branch-01'],
  },
  {
    email:       'mohamed@spektrumm.de',
    password:    'ChangeMe@2025!',
    displayName: 'محمد خالد',
    role:        'user',
    branches:    ['branch-02', 'branch-03'],
  },
  {
    email:       'fatima@spektrumm.de',
    password:    'ChangeMe@2025!',
    displayName: 'فاطمة حسن',
    role:        'user',
    branches:    ['branch-01', 'branch-02'],
  },
  {
    email:       'omar@spektrumm.de',
    password:    'ChangeMe@2025!',
    displayName: 'عمر يوسف',
    role:        'user',
    branches:    ['branch-04'],
  },
];

const SHEET_NAMES = ['Purchases', 'Kasa', 'Barcode', 'Phinex'];

const DEFAULT_COLUMNS = {
  Purchases: [
    { name: 'اسم المنتج',    type: 'text',     width: 200, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'الباركود',      type: 'text',     width: 160, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'الكمية',        type: 'number',   width: 100, formulaType: 'none', formulaDef: {}, format: { decimals: 0 }, frozen: false },
    { name: 'سعر الوحدة',    type: 'currency', width: 130, formulaType: 'none', formulaDef: {}, format: { decimals: 2, currency: 'EUR' }, frozen: false },
    { name: 'الإجمالي',      type: 'currency', width: 130, formulaType: 'arithmetic',
      formulaDef: {}, format: { decimals: 2, currency: 'EUR' }, frozen: false },
    { name: 'اسم المورد',    type: 'text',     width: 160, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'رقم الفاتورة',  type: 'text',     width: 140, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'تاريخ الشراء',  type: 'date',     width: 130, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'ملاحظات',       type: 'text',     width: 180, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
  ],
  Kasa: [
    { name: 'اسم المنتج',   type: 'text',     width: 200, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'الباركود',     type: 'text',     width: 160, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'سعر البيع',    type: 'currency', width: 130, formulaType: 'none', formulaDef: {}, format: { decimals: 2, currency: 'EUR' }, frozen: false },
    { name: 'سعر الشراء',   type: 'currency', width: 130, formulaType: 'none', formulaDef: {}, format: { decimals: 2, currency: 'EUR' }, frozen: false },
    { name: 'هامش الربح %', type: 'percentage', width: 130, formulaType: 'arithmetic', formulaDef: {}, format: { decimals: 1 }, frozen: false },
    { name: 'المخزون',      type: 'number',   width: 110, formulaType: 'none', formulaDef: {}, format: { decimals: 0 }, frozen: false },
  ],
  Barcode: [
    { name: 'الباركود',     type: 'text',   width: 180, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'اسم المنتج',   type: 'text',   width: 240, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'الفئة',        type: 'text',   width: 140, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'الوحدة',       type: 'text',   width: 100, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'المورد',       type: 'text',   width: 160, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
  ],
  Phinex: [
    { name: 'كود المورد',   type: 'text',     width: 140, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'اسم المورد',   type: 'text',     width: 200, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'البريد',       type: 'text',     width: 200, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'الهاتف',       type: 'text',     width: 140, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'شروط الدفع',   type: 'text',     width: 140, formulaType: 'none', formulaDef: {}, format: {}, frozen: false },
    { name: 'الرصيد',       type: 'currency', width: 130, formulaType: 'none', formulaDef: {}, format: { decimals: 2, currency: 'EUR' }, frozen: false },
  ],
};

/* ── SEED FUNCTIONS ── */

async function seedUsers() {
  console.log('\n📋 إنشاء المستخدمين...');
  const batch = db.batch();

  for (const userData of USERS) {
    try {
      // Create Firebase Auth user
      let fbUser;
      try {
        fbUser = await auth.createUser({
          email:        userData.email,
          password:     userData.password,
          displayName:  userData.displayName,
          emailVerified: true,
        });
        console.log(`  ✓ Auth: ${userData.email} (${fbUser.uid})`);
      } catch (err) {
        if (err.code === 'auth/email-already-exists') {
          fbUser = await auth.getUserByEmail(userData.email);
          console.log(`  ↺ Auth already exists: ${userData.email} (${fbUser.uid})`);
        } else {
          throw err;
        }
      }

      // Write Firestore profile
      const userRef = db.collection('users').doc(fbUser.uid);
      batch.set(userRef, {
        uid:         fbUser.uid,
        email:       userData.email,
        displayName: userData.displayName,
        role:        userData.role,
        branches:    userData.branches,
        disabled:    false,
        lastSeen:    null,
        createdAt:   FieldValue.serverTimestamp(),
        updatedAt:   FieldValue.serverTimestamp(),
      }, { merge: true });

    } catch (err) {
      console.error(`  ✕ Failed for ${userData.email}:`, err.message);
    }
  }

  await batch.commit();
  console.log('  ✓ User profiles committed to Firestore');
}

async function seedBranches() {
  console.log('\n🏪 إنشاء هيكل المحلات...');

  for (const branch of BRANCHES) {
    // Branch config doc
    await db.collection('branches').doc(branch.id)
      .collection('meta').doc('config')
      .set({
        id:        branch.id,
        name:      branch.name,
        city:      branch.city,
        label:     branch.label,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

    console.log(`  ✓ Branch: ${branch.id} — ${branch.name}`);

    // Sheet metadata with default columns
    for (const sheetName of SHEET_NAMES) {
      const cols = (DEFAULT_COLUMNS[sheetName] ?? []).map((c, i) => ({
        ...c,
        id:    `${branch.id}_${sheetName}_col_${i}`,
        index: i,
      }));

      await db.collection('branches').doc(branch.id)
        .collection('sheets').doc(sheetName)
        .set({
          columns:           cols,
          invoiceBoundaries: [],
          updatedAt:         FieldValue.serverTimestamp(),
        }, { merge: true });

      console.log(`    ✓ Sheet: ${sheetName} — ${cols.length} عمود`);
    }
  }
}

async function seedSystemConfig() {
  console.log('\n⚙️  إعدادات النظام...');
  await db.collection('config').doc('system').set({
    version:          '3.0',
    autoSave:         true,
    liveValidation:   true,
    activityLogging:  true,
    bgEffects:        true,
    maxRows:          50000,
    maxCols:          200,
    defaultCurrency:  'EUR',
    defaultLocale:    'de-DE',
    createdAt:        FieldValue.serverTimestamp(),
    updatedAt:        FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log('  ✓ System config set');
}

/* ── MAIN ── */
async function main() {
  console.log('════════════════════════════════════════');
  console.log('  GR Purchase v3 — Firestore Seed');
  console.log(`  Project: ${PROJECT_ID}`);
  console.log('════════════════════════════════════════');

  await seedUsers();
  await seedBranches();
  await seedSystemConfig();

  console.log('\n════════════════════════════════════════');
  console.log('  ✅ Seed مكتمل!');
  console.log('\n  بيانات الدخول التجريبية:');
  USERS.forEach(u => console.log(`  ${u.email}  /  ${u.password}`));
  console.log('\n  ⚠️  غيّر كلمات المرور بعد أول دخول!');
  console.log('════════════════════════════════════════\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\n✕ Seed فشل:', err);
  process.exit(1);
});
