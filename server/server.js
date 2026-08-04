require('dotenv').config();

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

// ── Route imports ─────────────────────────────────────────────────────
const authRoutes   = require('./routes/auth');
const taskRoutes   = require('./routes/tasks');
const userRoutes   = require('./routes/users');
const teamRoutes   = require('./routes/teams');
const deptRoutes   = require('./routes/departments');
const reportRoutes = require('./routes/reports');
const auditRoutes  = require('./routes/audit');
const notifRoutes  = require('./routes/notifications');
const emailRoutes  = require('./routes/emails');
const attachRoutes = require('./routes/attachments');
const kpiRoutes    = require('./routes/kpi');

const app = express();

// Hosted behind a single reverse proxy (Render/Railway) — without this,
// req.ip is the proxy's address and every user shares one rate-limit bucket.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// ── Security & middleware ─────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});
app.use('/api/', limiter);

// ── API routes ────────────────────────────────────────────────────────
app.use('/api/auth',        authRoutes);
app.use('/api/tasks',       taskRoutes);
app.use('/api/users',       userRoutes);
app.use('/api/teams',       teamRoutes);
app.use('/api/departments', deptRoutes);
app.use('/api/reports',     reportRoutes);
app.use('/api/audit',       auditRoutes);
app.use('/api/notifications', notifRoutes);
app.use('/api/emails',      emailRoutes);
app.use('/api/attachments', attachRoutes);
app.use('/api/kpi',         kpiRoutes);

// ── Health check ──────────────────────────────────────────────────────
app.get('/api/health', (_req, res) =>
  res.json({ status: 'OK', time: new Date(), env: process.env.NODE_ENV })
);

// ── Serve frontend ────────────────────────────────────────────────────
const clientDir = path.join(__dirname, '../client');
app.use(express.static(clientDir));
app.get('*', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));

// ── Connect to MongoDB & start server ─────────────────────────────────
const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('✅  MongoDB connected');
    if (process.env.SEED_DB === 'true') {
      await seedDatabase();
    }

    // Separate from SEED_DB: that flag seeds demo users/tasks and is off in
    // production, but the KPI module needs its scorecards to exist before it
    // can score anyone. This only creates templates that are missing and never
    // touches an edited one, so it is safe on every boot.
    try {
      const { seedKpiTemplates } = require('./services/kpi/seed');
      await seedKpiTemplates();
    } catch (err) {
      // A template seeding failure must not stop the CRM from serving.
      console.error('⚠️   KPI template seeding failed:', err.message);
    }
    app.listen(PORT, () =>
      console.log(`🚀  Server running on http://localhost:${PORT}`)
    );
  })
  .catch(err => {
    console.error('❌  MongoDB connection error:', err.message);
    process.exit(1);
  });

// ═════════════════════════════════════════════════════════════════════
//  DATABASE SEED
//  Runs once on first boot (skipped when users already exist).
// ═════════════════════════════════════════════════════════════════════
async function seedDatabase() {
  const User       = require('./models/User');
  const Department = require('./models/Department');
  const Team       = require('./models/Team');
  const Task       = require('./models/Task');

  const userCount = await User.countDocuments();
  if (userCount > 0) {
    console.log('📦  Database already seeded — skipping.');
    return;
  }

  console.log('🌱  Seeding database…');

  // ── Departments ───────────────────────────────────────────────────
  const depts = await Department.insertMany([
    { name: 'Engineering', color: '#2563eb' },
    { name: 'Product',     color: '#8b5cf6' },
    { name: 'Marketing',   color: '#ec4899' },
    { name: 'Finance',     color: '#d97706' },
  ]);
  const deptMap = Object.fromEntries(depts.map(d => [d.name, d]));

  // ── Users (passwords are hashed by the pre-save hook) ────────────
  const COLORS = ['#7c3aed','#2563eb','#0ea5e9','#ec4899','#8b5cf6','#16a34a','#d97706','#dc2626','#0891b2','#15803d','#c2410c'];

  const usersData = [
    { empId:'SA001',  username:'superadmin', name:'Alex Johnson',   email:'alex@company.com',   role:'superadmin', designation:'CEO / Owner',          department: deptMap['Engineering']._id, color: COLORS[0],  password:'admin123' },
    { empId:'AD001',  username:'admin1',     name:'Sarah Williams', email:'sarah@company.com',  role:'admin',      designation:'Department Head',       department: deptMap['Engineering']._id, color: COLORS[1],  password:'admin123' },
    { empId:'MG001',  username:'manager1',   name:'Mike Chen',      email:'mike@company.com',   role:'manager',    designation:'Frontend Team Lead',    department: deptMap['Engineering']._id, color: COLORS[2],  password:'admin123' },
    { empId:'MG002',  username:'manager2',   name:'Lisa Park',      email:'lisa@company.com',   role:'manager',    designation:'Backend Team Lead',     department: deptMap['Engineering']._id, color: COLORS[3],  password:'admin123' },
    { empId:'MG003',  username:'manager3',   name:'David Kim',      email:'david@company.com',  role:'manager',    designation:'Product Manager',       department: deptMap['Product']._id,     color: COLORS[4],  password:'admin123' },
    { empId:'EMP001', username:'emp001',     name:'Emma Davis',     email:'emma@company.com',   role:'employee',   designation:'Frontend Developer',    department: deptMap['Engineering']._id, color: COLORS[5],  password:'admin123' },
    { empId:'EMP002', username:'emp002',     name:'James Wilson',   email:'james@company.com',  role:'employee',   designation:'UI/UX Designer',        department: deptMap['Engineering']._id, color: COLORS[6],  password:'admin123' },
    { empId:'EMP003', username:'emp003',     name:'Sophie Brown',   email:'sophie@company.com', role:'employee',   designation:'React Developer',       department: deptMap['Engineering']._id, color: COLORS[7],  password:'admin123' },
    { empId:'EMP004', username:'emp004',     name:'Ryan Martinez',  email:'ryan@company.com',   role:'employee',   designation:'Backend Developer',     department: deptMap['Engineering']._id, color: COLORS[8],  password:'admin123' },
    { empId:'EMP005', username:'emp005',     name:'Olivia Taylor',  email:'olivia@company.com', role:'employee',   designation:'DevOps Engineer',       department: deptMap['Engineering']._id, color: COLORS[9],  password:'admin123' },
    { empId:'EMP006', username:'emp006',     name:'Noah Garcia',    email:'noah@company.com',   role:'employee',   designation:'Product Analyst',       department: deptMap['Product']._id,     color: COLORS[10], password:'admin123' },
    { empId:'EMP007', username:'emp007',     name:'Ava Anderson',   email:'ava@company.com',    role:'employee',   designation:'UX Researcher',         department: deptMap['Product']._id,     color: COLORS[0],  password:'admin123' },
  ];

  // insertMany bypasses pre-save hooks — use sequential create to trigger password hashing
  const createdUsers = [];
  for (const data of usersData) {
    const u = await User.create(data);
    createdUsers.push(u);
  }

  const findU = username => createdUsers.find(u => u.username === username);

  // ── Manager relationships ─────────────────────────────────────────
  await User.findByIdAndUpdate(findU('admin1')._id,   { manager: findU('superadmin')._id });
  await User.findByIdAndUpdate(findU('manager1')._id, { manager: findU('admin1')._id });
  await User.findByIdAndUpdate(findU('manager2')._id, { manager: findU('admin1')._id });
  await User.findByIdAndUpdate(findU('manager3')._id, { manager: findU('admin1')._id });

  for (const u of ['emp001','emp002','emp003']) {
    await User.findByIdAndUpdate(findU(u)._id, { manager: findU('manager1')._id });
  }
  for (const u of ['emp004','emp005']) {
    await User.findByIdAndUpdate(findU(u)._id, { manager: findU('manager2')._id });
  }
  for (const u of ['emp006','emp007']) {
    await User.findByIdAndUpdate(findU(u)._id, { manager: findU('manager3')._id });
  }

  // ── Teams ─────────────────────────────────────────────────────────
  const teams = await Team.insertMany([
    {
      name:       'Frontend Team',
      department: deptMap['Engineering']._id,
      manager:    findU('manager1')._id,
      members:    ['emp001','emp002','emp003'].map(u => findU(u)._id),
    },
    {
      name:       'Backend Team',
      department: deptMap['Engineering']._id,
      manager:    findU('manager2')._id,
      members:    ['emp004','emp005'].map(u => findU(u)._id),
    },
    {
      name:       'Product Team',
      department: deptMap['Product']._id,
      manager:    findU('manager3')._id,
      members:    ['emp006','emp007'].map(u => findU(u)._id),
    },
  ]);

  // Assign teams back to users
  for (const team of teams) {
    await User.findByIdAndUpdate(team.manager, { team: team._id });
    for (const memberId of team.members) {
      await User.findByIdAndUpdate(memberId, { team: team._id });
    }
  }

  // ── Seed tasks (last 14 days) ─────────────────────────────────────
  const PROJECTS  = ['Website Redesign','Mobile App','API Integration','Dashboard v2','Cloud Migration','Security Audit'];
  const TITLES    = ['Design wireframes','Implement auth module','Write unit tests','Code review','API documentation','Bug fixes','Performance audit','Client presentation','Sprint planning','Feature development','Database optimization','UI components','Integration testing','Deploy to staging'];
  const STATUSES  = ['completed','in-progress','not-started','delayed','on-hold'];
  const PRIORITIES = ['low','medium','high','critical'];

  const workers   = createdUsers.filter(u => ['employee','manager'].includes(u.role));
  const taskDocs  = [];

  for (let daysAgo = 13; daysAgo >= 0; daysAgo--) {
    const dt   = new Date();
    dt.setDate(dt.getDate() - daysAgo);
    const dateStr = dt.toISOString().split('T')[0];

    for (const u of workers) {
      const count = Math.floor(Math.random() * 2) + 1;

      for (let i = 0; i < count; i++) {
        const status     = daysAgo === 0
          ? STATUSES[Math.floor(Math.random() * 4)]
          : Math.random() > 0.12 ? 'completed' : STATUSES[Math.floor(Math.random() * 5)];
        const completion = status === 'completed'   ? 100
          : status === 'in-progress' ? Math.floor(Math.random() * 80) + 10
          : status === 'not-started' ? 0
          : Math.floor(Math.random() * 50);
        const approved   = daysAgo > 0 && status === 'completed' && Math.random() > 0.2;

        taskDocs.push({
          userId:      u._id,
          date:        dateStr,
          title:       TITLES[Math.floor(Math.random() * TITLES.length)],
          description: `Worked on ${TITLES[Math.floor(Math.random() * TITLES.length)].toLowerCase()} for the ${PROJECTS[Math.floor(Math.random() * PROJECTS.length)]} project.`,
          project:     PROJECTS[Math.floor(Math.random() * PROJECTS.length)],
          priority:    PRIORITIES[Math.floor(Math.random() * PRIORITIES.length)],
          status,
          startTime:   '09:00',
          endTime:     '17:30',
          hours:       Math.floor(Math.random() * 4) + 4,
          completion,
          challenges:  Math.random() > 0.6 ? 'Encountered some technical blockers.' : '',
          support:     'No',
          nextPlan:    `Continue with ${TITLES[Math.floor(Math.random() * TITLES.length)].toLowerCase()}`,
          approved,
          rejected:    !approved && daysAgo > 0 && Math.random() > 0.92,
          mgComment:   approved ? 'Good work!' : '',
          mgRating:    approved ? Math.floor(Math.random() * 2) + 4 : null,
          reviewedBy:  approved ? findU('manager1')._id : null,
          reviewedAt:  approved ? new Date() : null,
        });
      }
    }
  }

  await Task.insertMany(taskDocs);

  console.log(`✅  Seeded ${createdUsers.length} users, ${teams.length} teams, ${taskDocs.length} tasks`);
  console.log('🔑  Login credentials: any username above / password: admin123');
}
