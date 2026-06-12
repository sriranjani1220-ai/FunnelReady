// pipeline-scanner.js — Feature 3: Pipeline Integrity Check
// Analyzes opportunity pipeline for skipped stages, dead deals, owner concentration,
// amount anomalies, and forecast accuracy signals

async function runPipelineScan(conn) {
  const opps = await queryAll(conn, 'Opportunity', [
    'StageName', 'Amount', 'CloseDate', 'CreatedDate', 'IsClosed', 'IsWon',
    'Probability', 'LeadSource', 'OwnerId', 'AccountId', 'Type',
    'ForecastCategory', 'NextStep', 'Description'
  ]);

  // Fetch opportunity field history for stage progression analysis
  let stageHistory = [];
  try {
    const histResult = await conn.query(
      "SELECT OpportunityId, Field, OldValue, NewValue, CreatedDate FROM OpportunityFieldHistory WHERE Field = 'StageName' ORDER BY CreatedDate ASC LIMIT 2000"
    );
    stageHistory = histResult.records || [];
  } catch (err) {
    console.log('OpportunityFieldHistory not available (field tracking may not be enabled):', err.message);
  }

  const skippedStages = analyzeSkippedStages(opps, stageHistory);
  const deadPipeline = analyzeDeadPipeline(opps);
  const amountAnomalies = analyzeAmountAnomalies(opps);
  const ownerConcentration = analyzeOwnerConcentration(opps);
  const forecastHygiene = analyzeForecastHygiene(opps);
  const closedWonIntegrity = analyzeClosedWonIntegrity(opps);
  const nextStepDiscipline = analyzeNextStepDiscipline(opps);

  const scores = [
    skippedStages.score,
    deadPipeline.score,
    amountAnomalies.score,
    ownerConcentration.score,
    forecastHygiene.score,
    closedWonIntegrity.score,
    nextStepDiscipline.score
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
      recordCounts: { Opportunities: opps.length, 'Open Pipeline': opps.filter(o => !o.IsClosed).length, 'Closed Won': opps.filter(o => o.IsWon).length, 'Closed Lost': opps.filter(o => o.IsClosed && !o.IsWon).length },
      checkScores: {
        skippedStages: skippedStages.score,
        deadPipeline: deadPipeline.score,
        amountAnomalies: amountAnomalies.score,
        ownerConcentration: ownerConcentration.score,
        forecastHygiene: forecastHygiene.score,
        closedWonIntegrity: closedWonIntegrity.score,
        nextStepDiscipline: nextStepDiscipline.score
      }
    },
    details: {
      skippedStages,
      deadPipeline,
      amountAnomalies,
      ownerConcentration,
      forecastHygiene,
      closedWonIntegrity,
      nextStepDiscipline
    }
  };
}

async function queryAll(conn, objectName, fields) {
  const fieldList = ['Id', 'Name', ...fields.filter(f => f !== 'Name' && f !== 'Id')];
  const uniqueFields = [...new Set(fieldList)].join(', ');
  const soql = `SELECT ${uniqueFields} FROM ${objectName} LIMIT 2000`;
  try {
    const result = await conn.query(soql);
    return result.records || [];
  } catch (err) {
    console.error(`Pipeline query error for ${objectName}:`, err.message);
    return [];
  }
}

// --- 3.1 Skipped Stages ---
function analyzeSkippedStages(opps, stageHistory) {
  const STAGE_ORDER = [
    'Prospecting', 'Qualification', 'Needs Analysis', 'Value Proposition',
    'Id. Decision Makers', 'Perception Analysis', 'Proposal/Price Quote',
    'Negotiation/Review', 'Closed Won', 'Closed Lost'
  ];

  const skipped = [];
  const regressed = [];

  if (stageHistory.length > 0) {
    // Use field history for accurate detection
    const byOpp = {};
    for (const h of stageHistory) {
      if (!byOpp[h.OpportunityId]) byOpp[h.OpportunityId] = [];
      byOpp[h.OpportunityId].push(h);
    }

    for (const [oppId, history] of Object.entries(byOpp)) {
      const opp = opps.find(o => o.Id === oppId);
      if (!opp) continue;

      for (let i = 0; i < history.length; i++) {
        const oldIdx = STAGE_ORDER.indexOf(history[i].OldValue);
        const newIdx = STAGE_ORDER.indexOf(history[i].NewValue);

        if (oldIdx >= 0 && newIdx >= 0) {
          // Skipped: jumped forward 2+ stages
          if (newIdx - oldIdx > 1 && newIdx < STAGE_ORDER.indexOf('Closed Won')) {
            skipped.push({
              id: oppId, name: opp.Name,
              from: history[i].OldValue, to: history[i].NewValue,
              skippedCount: newIdx - oldIdx - 1,
              date: history[i].CreatedDate
            });
          }
          // Regressed: moved backward
          if (newIdx < oldIdx && !['Closed Lost'].includes(history[i].NewValue)) {
            regressed.push({
              id: oppId, name: opp.Name,
              from: history[i].OldValue, to: history[i].NewValue,
              date: history[i].CreatedDate
            });
          }
        }
      }
    }
  } else {
    // Fallback: detect obvious jumps by looking at closed deals
    for (const o of opps) {
      if (o.IsWon && o.StageName === 'Closed Won') {
        // Check if opp went directly from early stage to Closed Won (heuristic)
        // Without history we can only flag Closed Won with very early creation-to-close
        const created = new Date(o.CreatedDate);
        const closed = new Date(o.CloseDate);
        const days = Math.floor((closed - created) / (1000 * 60 * 60 * 24));
        if (days <= 1 && o.Amount && o.Amount > 1000) {
          skipped.push({
            id: o.Id, name: o.Name,
            from: 'Prospecting', to: 'Closed Won',
            skippedCount: 7, date: o.CloseDate,
            note: 'Won in 1 day (likely skipped stages)'
          });
        }
      }
    }
  }

  const totalOpps = opps.length;
  const issuePct = totalOpps > 0 ? ((skipped.length + regressed.length) / totalOpps) * 100 : 0;
  const score = Math.max(0, Math.round(100 - issuePct * 3));

  return {
    score: Math.min(100, score),
    skippedCount: skipped.length,
    regressedCount: regressed.length,
    skipped: skipped.slice(0, 20),
    regressed: regressed.slice(0, 20),
    historyAvailable: stageHistory.length > 0
  };
}

// --- 3.2 Dead Pipeline ---
function analyzeDeadPipeline(opps) {
  const now = new Date();
  const openOpps = opps.filter(o => !o.IsClosed);

  const deadDeals = []; // open but clearly dead
  const noActivity = []; // no next step, no description, past close date

  for (const o of openOpps) {
    const closeDate = o.CloseDate ? new Date(o.CloseDate) : null;
    const created = new Date(o.CreatedDate);
    const ageDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    const daysPast = closeDate ? Math.floor((now - closeDate) / (1000 * 60 * 60 * 24)) : 0;

    const isDead =
      (daysPast > 90) || // 3+ months past close date
      (ageDays > 365) || // over a year old and still open
      (o.Amount !== null && o.Amount !== undefined && (o.Amount === 0 || o.Amount === 1 || o.Amount < 0)); // $0/$1/negative

    if (isDead) {
      deadDeals.push({
        id: o.Id, name: o.Name, stage: o.StageName,
        amount: o.Amount || 0, closeDate: o.CloseDate,
        daysPastDue: daysPast, ageDays,
        reason: daysPast > 90 ? 'Past due 90+ days' :
                ageDays > 365 ? 'Open 1+ year' :
                'Zero/negative amount'
      });
    }

    // No activity signals
    const hasNoNextStep = !o.NextStep || o.NextStep.trim() === '';
    const hasNoDescription = !o.Description || o.Description.trim() === '';
    if (hasNoNextStep && hasNoDescription && daysPast > 0) {
      noActivity.push({
        id: o.Id, name: o.Name, stage: o.StageName,
        daysPastDue: daysPast
      });
    }
  }

  const deadPct = openOpps.length > 0 ? Math.round((deadDeals.length / openOpps.length) * 100) : 0;
  const score = Math.max(0, Math.round(100 - deadPct * 2));

  return {
    score: Math.min(100, score),
    deadCount: deadDeals.length,
    deadPct,
    noActivityCount: noActivity.length,
    deadDeals: deadDeals.sort((a, b) => b.daysPastDue - a.daysPastDue).slice(0, 20),
    noActivity: noActivity.slice(0, 15),
    totalOpen: openOpps.length,
    totalDeadAmount: deadDeals.reduce((sum, d) => sum + d.amount, 0)
  };
}

// --- 3.3 Amount Anomalies ---
function analyzeAmountAnomalies(opps) {
  const withAmount = opps.filter(o => o.Amount !== null && o.Amount !== undefined);
  if (withAmount.length === 0) return { score: 50, anomalies: [], stats: {}, noAmountCount: opps.length };

  const amounts = withAmount.map(o => o.Amount).filter(a => a > 0);
  const noAmount = opps.filter(o => o.Amount === null || o.Amount === undefined);
  const zeroAmount = withAmount.filter(o => o.Amount === 0);
  const negativeAmount = withAmount.filter(o => o.Amount < 0);

  // Calculate stats
  const sorted = [...amounts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const mean = amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
  const stdDev = Math.sqrt(amounts.reduce((sum, a) => sum + Math.pow(a - mean, 2), 0) / (amounts.length || 1));

  // Find outliers (>3 standard deviations from mean)
  const outlierThreshold = mean + 3 * stdDev;
  const outliers = withAmount.filter(o => o.Amount > outlierThreshold || o.Amount > 100000000);
  const tooSmall = withAmount.filter(o => o.Amount > 0 && o.Amount < 1); // fractional amounts

  const anomalies = [
    ...outliers.map(o => ({ id: o.Id, name: o.Name, amount: o.Amount, type: 'Unusually large', stage: o.StageName })),
    ...negativeAmount.map(o => ({ id: o.Id, name: o.Name, amount: o.Amount, type: 'Negative amount', stage: o.StageName })),
    ...zeroAmount.map(o => ({ id: o.Id, name: o.Name, amount: o.Amount, type: 'Zero amount', stage: o.StageName })),
    ...tooSmall.map(o => ({ id: o.Id, name: o.Name, amount: o.Amount, type: 'Fractional amount', stage: o.StageName }))
  ];

  const anomalyPct = opps.length > 0 ? ((anomalies.length + noAmount.length) / opps.length) * 100 : 0;
  const score = Math.max(0, Math.round(100 - anomalyPct * 1.5));

  return {
    score: Math.min(100, score),
    anomalies: anomalies.slice(0, 20),
    anomalyCount: anomalies.length,
    noAmountCount: noAmount.length,
    zeroAmountCount: zeroAmount.length,
    negativeCount: negativeAmount.length,
    outlierCount: outliers.length,
    stats: {
      median: Math.round(median),
      mean: Math.round(mean),
      min: sorted[0] || 0,
      max: sorted[sorted.length - 1] || 0,
      stdDev: Math.round(stdDev)
    }
  };
}

// --- 3.4 Owner Concentration ---
function analyzeOwnerConcentration(opps) {
  const openOpps = opps.filter(o => !o.IsClosed);
  if (openOpps.length === 0) return { score: 100, byOwner: {}, ownerCount: 0, concentration: 'N/A' };

  const byOwner = {};
  for (const o of openOpps) {
    const owner = o.OwnerId || 'Unknown';
    if (!byOwner[owner]) byOwner[owner] = { count: 0, amount: 0, ids: [] };
    byOwner[owner].count++;
    byOwner[owner].amount += (o.Amount || 0);
    byOwner[owner].ids.push(o.Id);
  }

  // Calculate concentration
  const ownerCount = Object.keys(byOwner).length;
  const sorted = Object.entries(byOwner).sort((a, b) => b[1].count - a[1].count);
  const topOwnerPct = openOpps.length > 0 ? Math.round((sorted[0][1].count / openOpps.length) * 100) : 0;

  // Single owner risk
  const singleOwner = ownerCount === 1;
  const heavyConcentration = topOwnerPct > 60;

  let concentration = 'Balanced';
  if (singleOwner) concentration = 'Single owner (critical risk)';
  else if (heavyConcentration) concentration = 'Heavy concentration (>60% with one owner)';
  else if (topOwnerPct > 40) concentration = 'Moderate concentration';

  // Add percentage to each owner
  for (const [owner, data] of Object.entries(byOwner)) {
    data.pct = Math.round((data.count / openOpps.length) * 100);
  }

  let score = 80;
  if (singleOwner) score = 30;
  else if (heavyConcentration) score -= 30;
  else if (topOwnerPct > 40) score -= 15;
  if (ownerCount >= 3 && topOwnerPct < 40) score = 90;

  return {
    score: Math.max(0, Math.min(100, score)),
    byOwner,
    ownerCount,
    topOwnerPct,
    concentration,
    singleOwner,
    totalOpen: openOpps.length
  };
}

// --- 3.5 Forecast Hygiene ---
function analyzeForecastHygiene(opps) {
  const openOpps = opps.filter(o => !o.IsClosed);
  if (openOpps.length === 0) return { score: 100, issues: [], missingCloseDate: 0, missingAmount: 0, missingStage: 0 };

  const issues = [];

  const missingCloseDate = openOpps.filter(o => !o.CloseDate);
  const missingAmount = openOpps.filter(o => o.Amount === null || o.Amount === undefined);
  const missingStage = openOpps.filter(o => !o.StageName);
  const missingProbability = openOpps.filter(o => o.Probability === null || o.Probability === undefined);

  // Close dates in the past (should have been updated)
  const now = new Date();
  const pastCloseDate = openOpps.filter(o => o.CloseDate && new Date(o.CloseDate) < now);

  // Close dates too far out (>18 months)
  const eighteenMonths = new Date();
  eighteenMonths.setMonth(eighteenMonths.getMonth() + 18);
  const farFuture = openOpps.filter(o => o.CloseDate && new Date(o.CloseDate) > eighteenMonths);

  // Probability mismatches (e.g., Prospecting with 90% probability)
  const probMismatch = openOpps.filter(o => {
    if (!o.StageName || o.Probability === null) return false;
    const early = ['Prospecting', 'Qualification'].includes(o.StageName);
    const late = ['Negotiation/Review', 'Proposal/Price Quote'].includes(o.StageName);
    if (early && o.Probability > 50) return true;
    if (late && o.Probability < 30) return true;
    return false;
  });

  const totalIssues = missingCloseDate.length + missingAmount.length + pastCloseDate.length + farFuture.length + probMismatch.length;
  const issuePct = openOpps.length > 0 ? (totalIssues / openOpps.length) * 100 : 0;
  const score = Math.max(0, Math.round(100 - issuePct * 1.2));

  return {
    score: Math.min(100, score),
    missingCloseDate: missingCloseDate.length,
    missingAmount: missingAmount.length,
    missingStage: missingStage.length,
    missingProbability: missingProbability.length,
    pastCloseDate: pastCloseDate.length,
    pastCloseDateOpps: pastCloseDate.map(o => ({ id: o.Id, name: o.Name, closeDate: o.CloseDate, stage: o.StageName })).slice(0, 15),
    farFuture: farFuture.length,
    farFutureOpps: farFuture.map(o => ({ id: o.Id, name: o.Name, closeDate: o.CloseDate })).slice(0, 10),
    probMismatch: probMismatch.length,
    probMismatchOpps: probMismatch.map(o => ({ id: o.Id, name: o.Name, stage: o.StageName, probability: o.Probability })).slice(0, 10),
    totalOpen: openOpps.length
  };
}

// --- 3.6 Closed Won Integrity ---
function analyzeClosedWonIntegrity(opps) {
  const wonOpps = opps.filter(o => o.IsWon);
  if (wonOpps.length === 0) return { score: 100, issues: [], totalWon: 0 };

  const issues = [];

  // Won with no amount
  const noAmount = wonOpps.filter(o => !o.Amount || o.Amount === 0);
  noAmount.forEach(o => issues.push({ id: o.Id, name: o.Name, issue: 'Won with $0 amount', value: o.Amount }));

  // Won with no account
  const noAccount = wonOpps.filter(o => !o.AccountId);
  noAccount.forEach(o => issues.push({ id: o.Id, name: o.Name, issue: 'Won with no Account linked' }));

  // Won with junk name
  const junkNames = /^(test|tbd|asdf|new opportunity|\.\.\.?|xxx|temp|sample)/i;
  const junkNamed = wonOpps.filter(o => o.Name && junkNames.test(o.Name.trim()));
  junkNamed.forEach(o => issues.push({ id: o.Id, name: o.Name, issue: 'Won with junk name' }));

  // Won same day as created (suspicious unless very small deal)
  const sameDayWon = wonOpps.filter(o => {
    if (!o.CreatedDate || !o.CloseDate) return false;
    const created = new Date(o.CreatedDate).toDateString();
    const closed = new Date(o.CloseDate).toDateString();
    return created === closed && o.Amount && o.Amount > 5000;
  });
  sameDayWon.forEach(o => issues.push({ id: o.Id, name: o.Name, issue: 'Won same day as created (>$5K)', value: '$' + (o.Amount || 0).toLocaleString() }));

  // Won with no type
  const noType = wonOpps.filter(o => !o.Type);
  noType.forEach(o => issues.push({ id: o.Id, name: o.Name, issue: 'Won with no Type' }));

  const issuePct = wonOpps.length > 0 ? (issues.length / wonOpps.length) * 100 : 0;
  const score = Math.max(0, Math.round(100 - issuePct * 2));

  return {
    score: Math.min(100, score),
    issues: issues.slice(0, 25),
    issueCount: issues.length,
    totalWon: wonOpps.length,
    noAmountCount: noAmount.length,
    noAccountCount: noAccount.length,
    junkNameCount: junkNamed.length,
    sameDayCount: sameDayWon.length,
    noTypeCount: noType.length
  };
}

// --- 3.7 Next Step Discipline ---
function analyzeNextStepDiscipline(opps) {
  const openOpps = opps.filter(o => !o.IsClosed);
  if (openOpps.length === 0) return { score: 100, missingNextStep: 0, totalOpen: 0 };

  const missingNextStep = openOpps.filter(o => !o.NextStep || o.NextStep.trim() === '');
  const hasNextStep = openOpps.filter(o => o.NextStep && o.NextStep.trim() !== '');

  // Vague next steps
  const vaguePatterns = /^(follow up|call|email|check|tbd|pending|waiting|none)$/i;
  const vagueNextStep = hasNextStep.filter(o => vaguePatterns.test(o.NextStep.trim()));

  const missingPct = openOpps.length > 0 ? Math.round((missingNextStep.length / openOpps.length) * 100) : 0;
  const vaguePct = hasNextStep.length > 0 ? Math.round((vagueNextStep.length / hasNextStep.length) * 100) : 0;

  // By stage: which stages have worst next step discipline
  const byStage = {};
  for (const o of openOpps) {
    const stage = o.StageName || 'Unknown';
    if (!byStage[stage]) byStage[stage] = { total: 0, missing: 0, vague: 0 };
    byStage[stage].total++;
    if (!o.NextStep || o.NextStep.trim() === '') byStage[stage].missing++;
    else if (vaguePatterns.test(o.NextStep.trim())) byStage[stage].vague++;
  }

  const score = Math.max(0, Math.round(100 - missingPct * 1.2 - vaguePct * 0.5));

  return {
    score: Math.min(100, score),
    missingNextStep: missingNextStep.length,
    missingPct,
    vagueNextStep: vagueNextStep.length,
    vaguePct,
    vagueExamples: vagueNextStep.slice(0, 10).map(o => ({ id: o.Id, name: o.Name, nextStep: o.NextStep })),
    byStage,
    totalOpen: openOpps.length
  };
}

module.exports = { runPipelineScan };
