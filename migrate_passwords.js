const { connectDB, getDb } = require('./db');

(async () => {
  try {
    await connectDB();
    const db = getDb();

    // Add default password 'cspc1234' to any user that doesn't have one
    const result = await db.collection('users').updateMany(
      { password: { $exists: false } },
      { $set: { password: 'cspc1234' } }
    );
    console.log('Migration complete. Users updated:', result.modifiedCount);

    const users = await db.collection('users').find(
      {},
      { projection: { id: 1, name: 1, email: 1, role: 1, status: 1, password: 1 } }
    ).toArray();

    console.log('\nAll users after migration:');
    users.forEach(u =>
      console.log(` [${u.id}] ${u.name} | ${u.email} | ${u.role} | ${u.status} | pwd: ${u.password ? 'set' : 'MISSING'}`)
    );

    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err.message);
    process.exit(1);
  }
})();
