'use strict';

const { addExpense, getExpenses } = require('./database');

async function trackExpense(userId, { amount, currency, category, description, date }) {
  const expense = {
    amount: parseFloat(amount),
    currency: currency || 'ILS',
    category: (category || 'general').toLowerCase(),
    description: description || '',
    date: date || new Date().toISOString().split('T')[0],
  };
  const id = await addExpense(userId, expense);
  return { id, ...expense, status: 'Expense recorded' };
}

async function listUserExpenses(userId, { startDate, endDate, category } = {}) {
  const expenses = await getExpenses(userId, { startDate, endDate, category });
  if (!expenses.length) return { expenses: [], message: 'No expenses found for this period.' };
  return { expenses, total: expenses.reduce((sum, e) => sum + (e.amount || 0), 0), currency: expenses[0]?.currency || 'ILS' };
}

async function expenseSummary(userId, { month, year } = {}) {
  const now = new Date();
  const m = month || now.getMonth() + 1;
  const y = year || now.getFullYear();
  const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
  const endMonth = m === 12 ? 1 : m + 1;
  const endYear = m === 12 ? y + 1 : y;
  const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

  const expenses = await getExpenses(userId, { startDate, endDate });
  if (!expenses.length) return { month: m, year: y, total: 0, categories: {}, count: 0, message: 'No expenses this month.' };

  const categories = {};
  let total = 0;
  for (const e of expenses) {
    const cat = e.category || 'general';
    categories[cat] = (categories[cat] || 0) + (e.amount || 0);
    total += e.amount || 0;
  }

  const sorted = Object.entries(categories)
    .sort(([, a], [, b]) => b - a)
    .map(([cat, sum]) => ({ category: cat, total: Math.round(sum * 100) / 100 }));

  return {
    month: m,
    year: y,
    total: Math.round(total * 100) / 100,
    currency: expenses[0]?.currency || 'ILS',
    count: expenses.length,
    categories: sorted,
  };
}

module.exports = { trackExpense, listUserExpenses, expenseSummary };
