// funnel-scanner.js — Feature 2: Funnel Health Analysis
// Analyzes Lead→Opportunity conversion funnel, pipeline health, and stage velocity

async function runFunnelScan(conn) {
  // Fetch leads with conversion and date fields
  const leads = await queryAll(conn, 'Lead', [
    'Status', 'IsConverted', 'ConvertedDate', 'ConvertedContactId', 'ConvertedAccountId',
    'ConvertedOpportunityId', 'CreatedDate', 'LeadSource', 'Company', 'Email',
    'FirstName', 'LastName', 'OwnerId'
  ]);

  // Fetch opportunities with stage and date fields
  const opps = await queryAll(conn, 'Opportunity', [
    'StageName', 'Amount', 'CloseDate', 'CreatedDate', 'IsClosed', 'IsWon',
    'Probability', 'LeadSource', 'OwnerId', 'AccountId', 'Type', 'ForecastCategory'
  ]);

  // Run all funnel checks
  const leadConversion = analyzeLeadConversion(leads);
  const leadAging = analyzeLeadAging(leads);
  const pipelineDistribution = analyzePipelineDistribution(opps);
  const stalePipeline = analyzeStalePipeline(opps);
  const stageVelocity = analyzeStageVelocity(opps);
  const winLoss = analyzeWinLoss(opps);
  const leadSourceROI = analyzeLeadSourceROI(leads, opps);

  // Calculate overall funnel health score
  const scores = [
    leadConversion.score,
    leadAging.score,
    pipelineDistribution.score,
    stalePipeline.score,
    stageVelocity.score,
    winLoss.score,
    leadSourceROI.score
  ];
  const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  let grade;
  if (avgScore >= 90) grade = 'A';
  else if (avgScore >= 75) grade = 'B';
  else if (avgScore >= 60) grade = 'C';
  else if (avgScore >= 40) grade = 'D';
  else grade = 'F';

  return {
    summary: {
      overallGrade: { score: avgScore, grade },
      recordCounts: { Leads: leads.length, Opportunities: opps.length },
      checkScores: {
        leadConversion: leadConversion.score,
        leadAging: leadAging.score,
        pipelineDistribution: pipelineDistribution.score,
        stalePipeline: stalePipeline.score,
        stageVelocity: stageVelocity.score,
        winLoss: winLoss.score,
        leadSourceROI: leadSourceROI.score
      }
    },
    details: {
      leadConversion,
      leadAging,
      pipelineDistribution,
      stalePipeline,
      stageVelocity,
      winLoss,
      leadSourceROI
    }
  };
}

// --- Query Helper ---
async function queryAll(conn, objectName, fields) {
  const fieldList = ['Id', 'Name', ...fields.filter(f => f !== 'Name' && f !== 'Id')];
  const uniqueFields = [...new Set(fieldList)].join(', ');
  const soql = `SELECT ${uniqueFields} FROM ${objectName} LIMIT 2000`;
  try {
    const result = await conn.query(soql);
    return result.records || [];
  } catch (err) {
    console.error(`Funnel query error for ${objectName}:`, err.message);
    return [];
  }
}

// --- 2.1 Lead Conversion Analysis ---
function analyzeLeadConversion(leads) {
  const total = leads.length;
  if (total === 0) return { score: 100, conversionRate: 0, converted: 0, unconverted: 0, qualifiedUnconverted: 0, byStatus: {} };

  const converted = leads.filter(l => l.IsConverted === true);
  const unconverted = leads.filter(l => l.IsConverted !== true);
  const qualifiedUnconverted = unconverted.filter(l =>
    l.Status && /qualified/i.test(l.Status) && l.IsConverted !== true
  );

  // Status distribution
  const byStatus = {};
  for (const l of leads) {
    const status = l.Status || 'Unknown';
    if (!byStatus[status]) byStatus[status] = { count: 0, ids: [] };
    byStatus[status].count++;
    byStatus[status].ids.push(l.Id);
  }

  const conversionRate = Math.round((converted.length / total) * 100);

  // Score: conversion rate contributes 60%, qualified-unconverted penalty 40%
  const convScore = Math.min(100, conversionRate * 2.5); // 40% conversion = 100 score
  const qualPenalty = total > 0 ? Math.round((qualifiedUnconverted.length / total) * 100) : 0;
  const score = Math.max(0, Math.round(convScore * 0.6 + (100 - qualPenalty * 2) * 0.4));

  return {
    score: Math.min(100, Math.max(0, score)),
    conversionRate,
    converted: converted.length,
    unconverted: unconverted.length,
    qualifiedUnconverted: qualifiedUnconverted.length,
    qualifiedUnconvertedIds: qualifiedUnconverted.map(l => ({ id: l.Id, name: l.Name || `${l.FirstName || ''} ${l.LastName || ''}`.trim(), status: l.Status })),
    byStatus,
    total
  };
}

// --- 2.2 Lead Aging Analysis ---
function analyzeLeadAging(leads) {
  const now = new Date();
  const openLeads = leads.filter(l => l.IsConverted !== true && l.Status && !/closed/i.test(l.Status));

  if (openLeads.length === 0) return { score: 100, avgAgeDays: 0, aging: {}, stuckLeads: [] };

  const ageBuckets = {
    '0-7 days': { count: 0, ids: [] },
    '8-30 days': { count: 0, ids: [] },
    '31-60 days': { count: 0, ids: [] },
    '61-90 days': { count: 0, ids: [] },
    '90+ days': { count: 0, ids: [] }
  };

  let totalAge = 0;
  const stuckLeads = [];

  for (const l of openLeads) {
    const created = new Date(l.CreatedDate);
    const ageDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    totalAge += ageDays;

    if (ageDays <= 7) { ageBuckets['0-7 days'].count++; ageBuckets['0-7 days'].ids.push(l.Id); }
    else if (ageDays <= 30) { ageBuckets['8-30 days'].count++; ageBuckets['8-30 days'].ids.push(l.Id); }
    else if (ageDays <= 60) { ageBuckets['31-60 days'].count++; ageBuckets['31-60 days'].ids.push(l.Id); }
    else if (ageDays <= 90) { ageBuckets['61-90 days'].count++; ageBuckets['61-90 days'].ids.push(l.Id); }
    else {
      ageBuckets['90+ days'].count++;
      ageBuckets['90+ days'].ids.push(l.Id);
      stuckLeads.push({
        id: l.Id,
        name: l.Name || `${l.FirstName || ''} ${l.LastName || ''}`.trim(),
        status: l.Status,
        ageDays,
        owner: l.OwnerId
      });
    }
  }

  const avgAgeDays = Math.round(totalAge / openLeads.length);
  const stuckPct = openLeads.length > 0 ? Math.round((ageBuckets['90+ days'].count / openLeads.length) * 100) : 0;

  // Score: penalize for old leads. Ideal avg age < 30 days
  const score = Math.max(0, Math.min(100, 100 - stuckPct * 1.5 - Math.max(0, avgAgeDays - 30)));

  return {
    score: Math.round(score),
    avgAgeDays,
    openLeadCount: openLeads.length,
    aging: ageBuckets,
    stuckLeads: stuckLeads.sort((a, b) => b.ageDays - a.ageDays).slice(0, 20),
    stuckCount: ageBuckets['90+ days'].count
  };
}

// --- 2.3 Pipeline Stage Distribution ---
function analyzePipelineDistribution(opps) {
  const openOpps = opps.filter(o => !o.IsClosed);
  if (openOpps.length === 0) return { score: 100, distribution: {}, totalOpen: 0, topHeavy: false };

  const stages = {};
  let totalAmount = 0;

  for (const o of openOpps) {
    const stage = o.StageName || 'Unknown';
    if (!stages[stage]) stages[stage] = { count: 0, amount: 0, ids: [] };
    stages[stage].count++;
    stages[stage].amount += (o.Amount || 0);
    stages[stage].ids.push(o.Id);
    totalAmount += (o.Amount || 0);
  }

  // Add percentage to each stage
  for (const [stage, data] of Object.entries(stages)) {
    data.pctCount = Math.round((data.count / openOpps.length) * 100);
    data.pctAmount = totalAmount > 0 ? Math.round((data.amount / totalAmount) * 100) : 0;
  }

  // Check if pipeline is top-heavy (>60% in early stages)
  const earlyStages = ['Prospecting', 'Qualification', 'Needs Analysis'];
  const earlyCount = earlyStages.reduce((sum, s) => sum + (stages[s]?.count || 0), 0);
  const topHeavy = openOpps.length > 0 && (earlyCount / openOpps.length) > 0.6;

  // Check if pipeline is bottom-heavy (>50% in negotiation/proposal)
  const lateStages = ['Proposal/Price Quote', 'Negotiation/Review', 'Proposal', 'Negotiation'];
  const lateCount = lateStages.reduce((sum, s) => sum + (stages[s]?.count || 0), 0);
  const bottomHeavy = openOpps.length > 0 && (lateCount / openOpps.length) > 0.5;

  // Score: penalize for imbalanced pipeline
  let score = 80;
  if (topHeavy) score -= 25;
  if (bottomHeavy) score -= 15;
  if (Object.keys(stages).length <= 1) score -= 20; // all in one stage = bad
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    distribution: stages,
    totalOpen: openOpps.length,
    totalAmount,
    topHeavy,
    bottomHeavy
  };
}

// --- 2.4 Stale Pipeline ---
function analyzeStalePipeline(opps) {
  const now = new Date();
  const openOpps = opps.filter(o => !o.IsClosed);
  if (openOpps.length === 0) return { score: 100, staleCount: 0, staleOpps: [], totalOpen: 0 };

  const staleOpps = [];
  const zombieOpps = []; // open for 6+ months past close date

  for (const o of openOpps) {
    if (o.CloseDate) {
      const closeDate = new Date(o.CloseDate);
      const daysPast = Math.floor((now - closeDate) / (1000 * 60 * 60 * 24));

      if (daysPast > 0) {
        const entry = {
          id: o.Id,
          name: o.Name,
          stage: o.StageName,
          closeDate: o.CloseDate,
          daysPastDue: daysPast,
          amount: o.Amount || 0
        };

        staleOpps.push(entry);
        if (daysPast > 180) zombieOpps.push(entry);
      }
    }
  }

  const stalePct = openOpps.length > 0 ? Math.round((staleOpps.length / openOpps.length) * 100) : 0;
  const score = Math.max(0, 100 - stalePct * 1.5);

  return {
    score: Math.round(score),
    staleCount: staleOpps.length,
    stalePct,
    zombieCount: zombieOpps.length,
    staleOpps: staleOpps.sort((a, b) => b.daysPastDue - a.daysPastDue).slice(0, 20),
    totalOpen: openOpps.length,
    totalStaleAmount: staleOpps.reduce((sum, o) => sum + o.amount, 0)
  };
}

// --- 2.5 Stage Velocity ---
function analyzeStageVelocity(opps) {
  const closedOpps = opps.filter(o => o.IsClosed && o.CreatedDate && o.CloseDate);
  if (closedOpps.length === 0) return { score: 100, avgCycleDays: 0, byStage: {}, wonVsLost: {} };

  let totalCycleDays = 0;
  const cycleDays = [];

  const wonCycles = [];
  const lostCycles = [];

  for (const o of closedOpps) {
    const created = new Date(o.CreatedDate);
    const closed = new Date(o.CloseDate);
    const days = Math.max(0, Math.floor((closed - created) / (1000 * 60 * 60 * 24)));
    totalCycleDays += days;
    cycleDays.push(days);

    if (o.IsWon) wonCycles.push(days);
    else lostCycles.push(days);
  }

  const avgCycleDays = Math.round(totalCycleDays / closedOpps.length);
  const avgWonCycle = wonCycles.length > 0 ? Math.round(wonCycles.reduce((a, b) => a + b, 0) / wonCycles.length) : 0;
  const avgLostCycle = lostCycles.length > 0 ? Math.round(lostCycles.reduce((a, b) => a + b, 0) / lostCycles.length) : 0;

  // Cycle time distribution
  const cycleBuckets = {
    '0-30 days': cycleDays.filter(d => d <= 30).length,
    '31-60 days': cycleDays.filter(d => d > 30 && d <= 60).length,
    '61-90 days': cycleDays.filter(d => d > 60 && d <= 90).length,
    '90+ days': cycleDays.filter(d => d > 90).length
  };

  // Score: ideal cycle < 60 days for mid-market
  let score = 80;
  if (avgCycleDays > 120) score -= 30;
  else if (avgCycleDays > 90) score -= 20;
  else if (avgCycleDays > 60) score -= 10;
  // Bonus for fast cycles
  if (avgCycleDays < 30) score += 15;
  score = Math.max(0, Math.min(100, score));

  return {
    score: Math.round(score),
    avgCycleDays,
    avgWonCycle,
    avgLostCycle,
    totalClosed: closedOpps.length,
    cycleBuckets,
    wonVsLost: {
      won: wonCycles.length,
      lost: lostCycles.length,
      avgWonDays: avgWonCycle,
      avgLostDays: avgLostCycle
    }
  };
}

// --- 2.6 Win/Loss Analysis ---
function analyzeWinLoss(opps) {
  const closedOpps = opps.filter(o => o.IsClosed);
  if (closedOpps.length === 0) return { score: 100, winRate: 0, won: 0, lost: 0, totalClosed: 0, bySource: {} };

  const won = closedOpps.filter(o => o.IsWon);
  const lost = closedOpps.filter(o => !o.IsWon);
  const winRate = Math.round((won.length / closedOpps.length) * 100);

  // Win rate by lead source
  const bySource = {};
  for (const o of closedOpps) {
    const source = o.LeadSource || 'Unknown';
    if (!bySource[source]) bySource[source] = { won: 0, lost: 0, total: 0, wonAmount: 0 };
    bySource[source].total++;
    if (o.IsWon) {
      bySource[source].won++;
      bySource[source].wonAmount += (o.Amount || 0);
    } else {
      bySource[source].lost++;
    }
  }

  // Calculate win rate per source
  for (const [source, data] of Object.entries(bySource)) {
    data.winRate = data.total > 0 ? Math.round((data.won / data.total) * 100) : 0;
  }

  // Win amount analysis
  const totalWonAmount = won.reduce((sum, o) => sum + (o.Amount || 0), 0);
  const avgDealSize = won.length > 0 ? Math.round(totalWonAmount / won.length) : 0;

  // Closed Won with no amount
  const wonNoAmount = won.filter(o => !o.Amount || o.Amount === 0);

  // Score based on win rate (benchmark: 20-30% is healthy)
  let score = 70;
  if (winRate >= 30) score = 90;
  else if (winRate >= 20) score = 80;
  else if (winRate >= 10) score = 60;
  else score = 40;

  // Penalty for won deals with no amount
  if (won.length > 0) {
    const noAmountPct = (wonNoAmount.length / won.length) * 100;
    score -= Math.round(noAmountPct * 0.3);
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    winRate,
    won: won.length,
    lost: lost.length,
    totalClosed: closedOpps.length,
    totalWonAmount,
    avgDealSize,
    wonNoAmount: wonNoAmount.length,
    wonNoAmountIds: wonNoAmount.map(o => ({ id: o.Id, name: o.Name })),
    bySource
  };
}

// --- 2.7 Lead Source ROI Analysis ---
function analyzeLeadSourceROI(leads, opps) {
  const sources = {};

  // Count leads by source
  for (const l of leads) {
    const source = l.LeadSource || 'Unknown';
    if (!sources[source]) sources[source] = { leads: 0, converted: 0, opps: 0, wonOpps: 0, wonAmount: 0 };
    sources[source].leads++;
    if (l.IsConverted) sources[source].converted++;
  }

  // Count opps by source
  for (const o of opps) {
    const source = o.LeadSource || 'Unknown';
    if (!sources[source]) sources[source] = { leads: 0, converted: 0, opps: 0, wonOpps: 0, wonAmount: 0 };
    sources[source].opps++;
    if (o.IsWon) {
      sources[source].wonOpps++;
      sources[source].wonAmount += (o.Amount || 0);
    }
  }

  // Calculate rates
  for (const [source, data] of Object.entries(sources)) {
    data.conversionRate = data.leads > 0 ? Math.round((data.converted / data.leads) * 100) : 0;
    data.winRate = data.opps > 0 ? Math.round((data.wonOpps / data.opps) * 100) : 0;
  }

  // Find sources with no attribution
  const noSourceLeads = leads.filter(l => !l.LeadSource || l.LeadSource.trim() === '');
  const noSourceOpps = opps.filter(o => !o.LeadSource || o.LeadSource.trim() === '');
  const noSourcePct = (leads.length + opps.length) > 0
    ? Math.round(((noSourceLeads.length + noSourceOpps.length) / (leads.length + opps.length)) * 100)
    : 0;

  // Score: penalize for missing source attribution
  let score = 80;
  if (noSourcePct > 50) score -= 30;
  else if (noSourcePct > 25) score -= 15;
  else if (noSourcePct > 10) score -= 5;

  // Bonus for having diverse, performing sources
  const performingSources = Object.values(sources).filter(s => s.leads > 0 && s.conversionRate > 10);
  if (performingSources.length >= 3) score += 10;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    sources,
    noSourceLeads: noSourceLeads.length,
    noSourceOpps: noSourceOpps.length,
    noSourcePct,
    totalSources: Object.keys(sources).filter(s => s !== 'Unknown').length
  };
}

module.exports = { runFunnelScan };
