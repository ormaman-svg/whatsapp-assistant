'use strict';

const { getDb } = require('./database');

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function getUsageStats() {
  const db = getDb();
  const usersSnap = await db.collection('users').get();

  const stats = {
    totalUsers: 0,
    activeUsers: 0,
    pendingUsers: 0,
    cancelledUsers: 0,
    planBreakdown: { admin: 0, pro: 0, basic: 0, unknown: 0 },
    googleConnected: 0,
    recentUsers: [],
  };

  for (const doc of usersSnap.docs) {
    const data = doc.data();
    stats.totalUsers++;

    if (data.status === 'active') stats.activeUsers++;
    else if (data.status === 'pending') stats.pendingUsers++;
    else if (data.status === 'cancelled') stats.cancelledUsers++;

    const plan = data.plan || 'unknown';
    stats.planBreakdown[plan] = (stats.planBreakdown[plan] || 0) + 1;

    if (data.googleConnected) stats.googleConnected++;

    stats.recentUsers.push({
      phone: doc.id,
      status: data.status || 'unknown',
      plan: data.plan || 'none',
      name: data.name || null,
      google: !!data.googleConnected,
      created: data.createdAt?.toDate?.()?.toISOString() || null,
    });
  }

  stats.recentUsers.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  stats.recentUsers = stats.recentUsers.slice(0, 50);

  const sessionsSnap = await db.collection('sessions').get();
  stats.totalSessions = sessionsSnap.size;

  return stats;
}

function renderDashboard(stats) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rio Analytics</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px}
h1{font-size:28px;margin-bottom:24px;color:#38bdf8}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px}
.card{background:#1e293b;border-radius:12px;padding:20px;text-align:center}
.card .num{font-size:36px;font-weight:700;color:#38bdf8}
.card .label{font-size:13px;color:#94a3b8;margin-top:4px}
table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}
th{background:#334155;text-align:left;padding:12px 16px;font-size:13px;color:#94a3b8}
td{padding:10px 16px;border-top:1px solid #334155;font-size:14px}
tr:hover{background:#334155}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600}
.badge.active{background:#065f46;color:#34d399}
.badge.pending{background:#78350f;color:#fbbf24}
.badge.cancelled{background:#7f1d1d;color:#fca5a5}
.badge.admin{background:#1e3a5f;color:#60a5fa}
.badge.pro{background:#4c1d95;color:#a78bfa}
.badge.basic{background:#365314;color:#86efac}
</style>
</head>
<body>
<h1>Rio Analytics Dashboard</h1>
<div class="grid">
<div class="card"><div class="num">${stats.totalUsers}</div><div class="label">Total Users</div></div>
<div class="card"><div class="num">${stats.activeUsers}</div><div class="label">Active</div></div>
<div class="card"><div class="num">${stats.pendingUsers}</div><div class="label">Pending</div></div>
<div class="card"><div class="num">${stats.cancelledUsers}</div><div class="label">Cancelled</div></div>
<div class="card"><div class="num">${stats.googleConnected}</div><div class="label">Google Connected</div></div>
<div class="card"><div class="num">${stats.totalSessions}</div><div class="label">Sessions</div></div>
<div class="card"><div class="num">${stats.planBreakdown.pro || 0}</div><div class="label">Pro Users</div></div>
<div class="card"><div class="num">${stats.planBreakdown.basic || 0}</div><div class="label">Basic Users</div></div>
</div>
<h2 style="margin-bottom:12px;color:#94a3b8">Users</h2>
<table>
<tr><th>Phone</th><th>Name</th><th>Status</th><th>Plan</th><th>Google</th><th>Joined</th></tr>
${stats.recentUsers.map(u => `<tr>
<td>${esc(u.phone)}</td>
<td>${esc(u.name) || '—'}</td>
<td><span class="badge ${esc(u.status)}">${esc(u.status)}</span></td>
<td><span class="badge ${esc(u.plan)}">${esc(u.plan)}</span></td>
<td>${u.google ? '✅' : '—'}</td>
<td>${u.created ? new Date(u.created).toLocaleDateString('he-IL') : '—'}</td>
</tr>`).join('\n')}
</table>
</body></html>`;
}

module.exports = { getUsageStats, renderDashboard };
