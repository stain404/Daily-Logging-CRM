// One-time reset: wipes all seeded/dummy data and creates a single real
// superadmin account so you can log in and rebuild departments, teams, and
// employees for real through the admin UI.
//
// EDIT the values below, then run once from the server/ folder:
//   node scripts/resetToRealData.js

require('dotenv').config();
const mongoose = require('mongoose');

const NEW_SUPERADMIN = {
  empId:       'SA001',
  username:    'Khasim',
  name:        'Khasim',
  email:       'ceo@alqubainvestment.com',
  designation: 'Owner / Admin',
  password:    'AlQuba@Adm!n',
};

async function run() {
  if (Object.values(NEW_SUPERADMIN).some(v => v.startsWith('CHANGE_ME'))) {
    console.error('❌  Edit the NEW_SUPERADMIN values at the top of this script before running it.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅  Connected to MongoDB');

  const User       = require('../models/User');
  const Task       = require('../models/Task');
  const Team       = require('../models/Team');
  const Department = require('../models/Department');

  const [tasks, teams, depts, users] = await Promise.all([
    Task.deleteMany({}),
    Team.deleteMany({}),
    Department.deleteMany({}),
    User.deleteMany({}),
  ]);
  console.log(`🗑️   Removed ${tasks.deletedCount} tasks, ${teams.deletedCount} teams, ${depts.deletedCount} departments, ${users.deletedCount} users`);

  const superadmin = await User.create({ ...NEW_SUPERADMIN, role: 'superadmin' });
  console.log(`🔑  Created superadmin "${superadmin.username}" — log in with this account to rebuild your real org.`);

  await mongoose.disconnect();
  console.log('✅  Done.');
}

run().catch(err => {
  console.error('❌  Reset failed:', err);
  process.exit(1);
});
