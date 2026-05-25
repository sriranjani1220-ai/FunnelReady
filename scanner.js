// scanner.js — Data Quality Score engine (Feature 1)
// Runs 7 sub-checks against a Salesforce org and returns scores + findings

// Critical fields per object (10 each)
const CRITICAL_FIELDS = {
  Lead: ['Email', 'Phone', 'Company', 'LeadSource', 'Title', 'FirstName', 'LastName', 'Status', 'Industry', 'City'],
  Contact: ['Email', 'Phone', 'Title', 'AccountId', 'FirstName', 'LastName', 'MailingCity', 'Department', 'LeadSource', 'OwnerId'],
  Account: ['Industry', 'Phone', 'Website', 'NumberOfEmployees', 'AnnualRevenue', 'BillingCity', 'Type', 'Description', 'OwnerId', 'Rating'],
  Opportunity: ['Amount', 'Type', 'CloseDate', 'StageName', 'Probability', 'LeadSource', 'NextStep', 'Description', 'OwnerId', 'AccountId']
};

// Junk patterns
const JUNK_PATTERNS = [
  /^test$/i, /^tbd$/i, /^n\/?a$/i, /^none$/i, /^asdf/i, /^xxx/i,
  /^unknown$/i, /^null$/i, /^undefined$/i, /^\.\.\.*$/, /^fake/i,
  /^do not/i, /^delete/i, /^remove/i, /^aaa/i, /^zzz/i,
  /^temp/i, /^sample$/i, /^dummy/i, /^placeholder/i
];

const SUSPICIOUS_PATTERNS = [
  /^.{1,2}$/, // 1-2 char values
  /@example\.com$/i,
  /@test\.com$/i,
  /^info@/i,
  /^admin@/i,
  /^noreply@/i
];

// Phone format regex patterns
const PHONE_FORMATS = {
  '(XXX) XXX-XXXX': /^\(\d{3}\) \d{3}-\d{4}$/,
  'XXX-XXX-XXXX': /^\d{3}-\d{3}-\d{4}$/,
  'XXXXXXXXXX': /^\d{10}$/,
  '+1XXXXXXXXXX': /^\+1\d{10}$/,
  'Other': /./
};

async function runFullScan(conn) {
  // Extra fields needed for format checks (not in critical fields)
  const FORMAT_EXTRA_FIELDS = {
    Lead: ['State', 'Country'],
    Contact: ['MailingState', 'MailingCountry'],
    Account: ['BillingState', 'BillingCountry'],
    Opportunity: []
  };

  // Fetch all records (critical fields + format-check fields)
  const [leads, contacts, accounts, opportunities] = await Promise.all([
    queryAll(conn, 'Lead', [...CRITICAL_FIELDS.Lead, ...FORMAT_EXTRA_FIELDS.Lead]),
    queryAll(conn, 'Contact', [...CRITICAL_FIELDS.Contact, ...FORMAT_EXTRA_FIELDS.Contact]),
    queryAll(conn, 'Account', [...CRITICAL_FIELDS.Account, ...FORMAT_EXTRA_FIELDS.Account]),
    queryAll(conn, 'Opportunity', CRITICAL_FIELDS.Opportunity)
  ]);

  const data = { Lead: leads, Contact: contacts, Account: accounts, Opportunity: opportunities };

  // Run all sub-checks
  const fieldCompleteness = checkFieldCompleteness(data);
  const duplicates = checkDuplicates(data);
  const formatConsistency = checkFormatConsistency(data);
  const junkData = checkJunkData(data);
  const dataIntegrity = checkDataIntegrity(data);
  const objectScores = calcObjectScores(fieldCompleteness, duplicates, formatConsistency, junkData, dataIntegrity, data);
  const overallGrade = calcOverallGrade(objectScores);

  return {
    summary: {
      recordCounts: {
        Lead: leads.length,
        Contact: contacts.length,
        Account: accounts.length,
        Opportunity: opportunities.length
      },
      overallGrade,
      objectScores
    },
    details: {
      fieldCompleteness,
      duplicates,
      formatConsistency,
      junkData,
      dataIntegrity
    }
  };
}

// --- Query helper ---
async function queryAll(conn, objectName, fields) {
  const fieldList = ['Id', 'Name', ...fields.filter(f => f !== 'Name')].join(', ');
  const soql = `SELECT ${fieldList} FROM ${objectName} LIMIT 2000`;
  try {
    const result = await conn.query(soql);
    console.log(`${objectName}: ${(result.records || []).length} records fetched`);
    return result.records || [];
  } catch (err) {
    console.error(`Query error for ${objectName}:`, err.message);
    console.error(`SOQL: ${soql}`);
    return [];
  }
}

// --- 1.1 Field Completeness ---
function checkFieldCompleteness(data) {
  const results = {};

  for (const [objectName, records] of Object.entries(data)) {
    const fields = CRITICAL_FIELDS[objectName];
    const fieldStats = {};

    for (const field of fields) {
      const missing = records.filter(r => isEmpty(r[field]));
      fieldStats[field] = {
        total: records.length,
        filled: records.length - missing.length,
        missing: missing.length,
        percent: records.length ? Math.round(((records.length - missing.length) / records.length) * 100) : 100,
        missingIds: missing.map(r => r.Id)
      };
    }

    const totalFields = fields.length * records.length;
    const totalFilled = Object.values(fieldStats).reduce((sum, s) => sum + s.filled, 0);
    const score = totalFields ? Math.round((totalFilled / totalFields) * 100) : 100;

    results[objectName] = { score, fields: fieldStats };
  }

  return results;
}

// --- 1.2 Duplicate Detection ---
function checkDuplicates(data) {
  const results = {};

  // Lead duplicates by Email
  results.Lead = findDuplicates(data.Lead, 'Email', 'Lead');

  // Contact duplicates by Email
  results.Contact = findDuplicates(data.Contact, 'Email', 'Contact');

  // Account duplicates by Name (normalized)
  results.Account = findDuplicatesByNormalizedName(data.Account, 'Account');

  // Opportunity - no natural duplicate key, skip
  results.Opportunity = { score: 100, duplicateGroups: [], count: 0 };

  return results;
}

function findDuplicates(records, field, objectName) {
  const seen = {};
  const duplicates = [];

  for (const r of records) {
    const val = (r[field] || '').toLowerCase().trim();
    if (!val) continue;
    if (!seen[val]) seen[val] = [];
    seen[val].push(r.Id);
  }

  const duplicateGroups = Object.entries(seen)
    .filter(([, ids]) => ids.length > 1)
    .map(([value, ids]) => ({ value, ids, count: ids.length }));

  const dupCount = duplicateGroups.reduce((sum, g) => sum + g.count - 1, 0);
  const score = records.length ? Math.round(((records.length - dupCount) / records.length) * 100) : 100;

  return { score, duplicateGroups, count: dupCount };
}

function findDuplicatesByNormalizedName(records, objectName) {
  const seen = {};

  for (const r of records) {
    const name = (r.Name || '').toLowerCase().trim()
      .replace(/\s+(inc\.?|llc|ltd|corp\.?)$/i, '')
      .replace(/[^a-z0-9]/g, '');
    if (!name) continue;
    if (!seen[name]) seen[name] = [];
    seen[name].push({ id: r.Id, originalName: r.Name });
  }

  const duplicateGroups = Object.entries(seen)
    .filter(([, items]) => items.length > 1)
    .map(([normalized, items]) => ({
      value: items[0].originalName,
      ids: items.map(i => i.id),
      count: items.length
    }));

  const dupCount = duplicateGroups.reduce((sum, g) => sum + g.count - 1, 0);
  const score = records.length ? Math.round(((records.length - dupCount) / records.length) * 100) : 100;

  return { score, duplicateGroups, count: dupCount };
}

// --- 1.3 Format Consistency ---
function checkFormatConsistency(data) {
  const results = {};

  // Check phone format consistency per object
  for (const [objectName, records] of Object.entries(data)) {
    const phoneRecords = records.filter(r => r.Phone && r.Phone.trim());
    const formatCounts = {};

    for (const r of phoneRecords) {
      const phone = r.Phone.trim();
      let matched = 'Other';
      for (const [fmt, regex] of Object.entries(PHONE_FORMATS)) {
        if (fmt !== 'Other' && regex.test(phone)) {
          matched = fmt;
          break;
        }
      }
      if (!formatCounts[matched]) formatCounts[matched] = [];
      formatCounts[matched].push({ id: r.Id, value: phone });
    }

    // Score: what % use the dominant format
    const formats = Object.entries(formatCounts).sort((a, b) => b[1].length - a[1].length);
    const dominant = formats[0];
    const score = phoneRecords.length ? Math.round((dominant[1].length / phoneRecords.length) * 100) : 100;

    results[objectName] = {
      score,
      phoneFormats: Object.fromEntries(formats.map(([fmt, items]) => [fmt, { count: items.length, ids: items.map(i => i.id), records: items }])),
      dominantFormat: dominant ? dominant[0] : 'N/A',
      totalWithPhone: phoneRecords.length
    };
  }

  // Also check Account name casing consistency
  const accountNames = data.Account.filter(r => r.Name);
  const casingIssues = accountNames.filter(r => {
    const n = r.Name;
    return n === n.toUpperCase() || n === n.toLowerCase() || /^\s|\s$/.test(n);
  });
  results.Account.namingIssues = {
    count: casingIssues.length,
    ids: casingIssues.map(r => r.Id),
    records: casingIssues.map(r => ({ id: r.Id, value: r.Name })),
    examples: casingIssues.slice(0, 5).map(r => r.Name)
  };

  // Adjust Account score to factor in naming
  if (accountNames.length) {
    const namingScore = Math.round(((accountNames.length - casingIssues.length) / accountNames.length) * 100);
    results.Account.score = Math.round((results.Account.score + namingScore) / 2);
  }

  // State/Country picklist standardization
  const stateFields = { Lead: 'State', Contact: 'MailingState', Account: 'BillingState' };
  const countryFields = { Lead: 'Country', Contact: 'MailingCountry', Account: 'BillingCountry' };

  // Common abbreviation vs full name mismatches
  const STATE_ABBREVS = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
    'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'florida': 'FL', 'georgia': 'GA',
    'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
    'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO',
    'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
    'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH',
    'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT',
    'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY'
  };
  const VALID_ABBREVS = new Set(Object.values(STATE_ABBREVS));

  for (const obj of ['Lead', 'Contact', 'Account']) {
    const stateField = stateFields[obj];
    const countryField = countryFields[obj];
    const records = data[obj];

    const stateIssues = [];
    const countryIssues = [];
    const stateFormats = {}; // track abbreviation vs full name usage

    for (const r of records) {
      const state = r[stateField];
      if (state && state.trim()) {
        const val = state.trim();
        // Classify format: abbreviation (2-char uppercase) vs full name vs other
        let fmt;
        if (VALID_ABBREVS.has(val.toUpperCase()) && val.length === 2) {
          fmt = 'Abbreviation (e.g. CA)';
        } else if (STATE_ABBREVS[val.toLowerCase()]) {
          fmt = 'Full name (e.g. California)';
        } else if (val.length <= 3) {
          fmt = 'Abbreviation (e.g. CA)';
        } else {
          fmt = 'Full name (e.g. California)';
        }

        if (!stateFormats[fmt]) stateFormats[fmt] = [];
        stateFormats[fmt].push({ id: r.Id, value: val });

        // Flag mixed case or leading/trailing spaces
        if (val !== state || /^\s|\s$/.test(state)) {
          stateIssues.push({ id: r.Id, value: state });
        }
      }

      const country = r[countryField];
      if (country && country.trim()) {
        const val = country.trim();
        // Flag inconsistencies: "US" vs "USA" vs "United States" vs "U.S."
        if (/^(us|usa|u\.s\.?a?\.?|united states of america)$/i.test(val) && val !== 'United States' && val !== 'US') {
          countryIssues.push({ id: r.Id, value: val, suggested: 'US or United States' });
        }
      }
    }

    // Determine if there's a mix of abbreviation vs full name
    const stateFormatEntries = Object.entries(stateFormats).sort((a, b) => b[1].length - a[1].length);
    const hasMixedStateFormats = stateFormatEntries.length > 1;

    results[obj].stateCountry = {
      stateFormats: Object.fromEntries(stateFormatEntries.map(([fmt, items]) => [fmt, { count: items.length, ids: items.map(i => i.id), records: items }])),
      hasMixedStateFormats,
      countryIssues: { count: countryIssues.length, records: countryIssues }
    };

    // Factor state/country into the score
    const totalStateRecords = stateFormatEntries.reduce((sum, [, ids]) => sum + ids.length, 0);
    if (totalStateRecords > 0 || countryIssues.length > 0) {
      let stateScore = 100;
      if (hasMixedStateFormats && totalStateRecords > 0) {
        const dominant = stateFormatEntries[0][1].length;
        stateScore = Math.round((dominant / totalStateRecords) * 100);
      }
      const countryScore = totalStateRecords > 0
        ? Math.round(((totalStateRecords - countryIssues.length) / totalStateRecords) * 100)
        : 100;
      // Average with existing score
      results[obj].score = Math.round((results[obj].score + stateScore + countryScore) / 3);
    }
  }

  return results;
}

// --- 1.4 Junk Data Detection ---
function checkJunkData(data) {
  const results = {};

  for (const [objectName, records] of Object.entries(data)) {
    const junkRecords = [];
    const suspiciousRecords = [];

    for (const r of records) {
      const nameVal = r.Name || `${r.FirstName || ''} ${r.LastName || ''}`.trim();
      const companyVal = r.Company || '';
      const emailVal = r.Email || '';

      // Check each field individually so we know which one triggered
      const fieldsToCheck = [
        { field: 'Name', value: nameVal },
        { field: 'Company', value: companyVal }
      ];

      let matched = false;

      for (const { field, value } of fieldsToCheck) {
        if (!value) continue;
        const trimmed = value.trim();
        const junkMatch = JUNK_PATTERNS.find(p => p.test(trimmed));
        if (junkMatch) {
          junkRecords.push({ id: r.Id, field, value: trimmed, pattern: junkMatch.source });
          matched = true;
          break;
        }
      }

      if (!matched && emailVal) {
        const trimmed = emailVal.trim();
        const susMatch = SUSPICIOUS_PATTERNS.find(p => p.test(trimmed));
        if (susMatch) {
          suspiciousRecords.push({ id: r.Id, field: 'Email', value: trimmed, pattern: susMatch.source });
          matched = true;
        }
      }

      if (!matched) {
        for (const { field, value } of fieldsToCheck) {
          if (value && SUSPICIOUS_PATTERNS[0].test(value.trim())) {
            suspiciousRecords.push({ id: r.Id, field, value: value.trim(), pattern: 'too_short' });
            matched = true;
            break;
          }
        }
      }
    }

    const totalBad = junkRecords.length + suspiciousRecords.length;
    const score = records.length ? Math.round(((records.length - totalBad) / records.length) * 100) : 100;

    results[objectName] = {
      score,
      junk: { count: junkRecords.length, records: junkRecords },
      suspicious: { count: suspiciousRecords.length, records: suspiciousRecords }
    };
  }

  return results;
}

// --- 1.5 Data Integrity Validation ---
function checkDataIntegrity(data) {
  const results = {};
  const issues = [];

  // Opportunities: unrealistic amounts
  for (const opp of data.Opportunity) {
    if (opp.Amount !== null && opp.Amount !== undefined) {
      if (opp.Amount > 100000000) {
        issues.push({ id: opp.Id, object: 'Opportunity', name: opp.Name, issue: 'amount_too_high', value: opp.Amount });
      }
      if (opp.Amount < 0) {
        issues.push({ id: opp.Id, object: 'Opportunity', name: opp.Name, issue: 'negative_amount', value: opp.Amount });
      }
    }
    // Stale: past close date but still open
    if (opp.CloseDate && opp.StageName && !opp.StageName.startsWith('Closed')) {
      if (new Date(opp.CloseDate) < new Date()) {
        issues.push({ id: opp.Id, object: 'Opportunity', name: opp.Name, issue: 'past_close_date_still_open', value: opp.CloseDate });
      }
    }
    // Far future close date (>2 years out)
    if (opp.CloseDate) {
      const twoYearsOut = new Date();
      twoYearsOut.setFullYear(twoYearsOut.getFullYear() + 2);
      if (new Date(opp.CloseDate) > twoYearsOut) {
        issues.push({ id: opp.Id, object: 'Opportunity', name: opp.Name, issue: 'close_date_too_far', value: opp.CloseDate });
      }
    }
  }

  // Accounts: unrealistic employee/revenue combos
  for (const acc of data.Account) {
    if (acc.NumberOfEmployees !== null && acc.NumberOfEmployees !== undefined) {
      if (acc.NumberOfEmployees > 500000) {
        issues.push({ id: acc.Id, object: 'Account', name: acc.Name, issue: 'unrealistic_employees', value: acc.NumberOfEmployees });
      }
    }
    if (acc.AnnualRevenue !== null && acc.AnnualRevenue !== undefined) {
      if (acc.NumberOfEmployees === 0 && acc.AnnualRevenue > 1000000) {
        issues.push({ id: acc.Id, object: 'Account', name: acc.Name, issue: 'zero_employees_high_revenue', value: `${acc.NumberOfEmployees} emp / $${acc.AnnualRevenue}` });
      }
    }
  }

  // Leads: qualified but never converted, stuck too long, invalid status
  for (const lead of data.Lead) {
    // Qualified but still a lead (should have been converted)
    if (lead.Status === 'Closed - Converted') {
      issues.push({ id: lead.Id, object: 'Lead', name: lead.Name || `${lead.FirstName} ${lead.LastName}`, issue: 'fake_conversion_status' });
    }
    // Leads with no company or single-char company
    if (lead.Company && lead.Company.trim().length <= 1) {
      issues.push({ id: lead.Id, object: 'Lead', name: lead.Name || `${lead.FirstName} ${lead.LastName}`, issue: 'invalid_company', value: lead.Company });
    }
    // Leads with no useful data (no email, no phone, no company or junk company)
    const hasNoEmail = isEmpty(lead.Email);
    const hasNoPhone = isEmpty(lead.Phone);
    const junkCompany = !lead.Company || /^(unknown|n\/?a|xxx|asdf|test|none)$/i.test(lead.Company.trim());
    if (hasNoEmail && hasNoPhone && junkCompany) {
      issues.push({ id: lead.Id, object: 'Lead', name: lead.Name || `${lead.FirstName} ${lead.LastName}`, issue: 'zero_useful_data' });
    }
  }

  // Orphan contacts (no AccountId)
  const orphanContacts = data.Contact.filter(c => isEmpty(c.AccountId));
  for (const c of orphanContacts) {
    issues.push({ id: c.Id, object: 'Contact', name: c.Name || `${c.FirstName} ${c.LastName}`, issue: 'orphan_no_account' });
  }

  const totalRecords = Object.values(data).reduce((sum, recs) => sum + recs.length, 0);
  const score = totalRecords ? Math.round(((totalRecords - issues.length) / totalRecords) * 100) : 100;

  results.score = Math.max(0, score);
  results.issues = issues;
  results.count = issues.length;

  return results;
}

// --- 1.6 Object-Level Scoring ---
function calcObjectScores(fieldComp, duplicates, format, junk, integrity, data) {
  const objects = ['Lead', 'Contact', 'Account', 'Opportunity'];
  const scores = {};

  for (const obj of objects) {
    const fc = fieldComp[obj]?.score || 100;
    const dup = duplicates[obj]?.score || 100;
    const fmt = format[obj]?.score || 100;
    const jk = junk[obj]?.score || 100;

    // Integrity is global — attribute proportionally
    const objIssues = integrity.issues.filter(i => i.object === obj).length;
    const objTotal = data[obj].length;
    const intScore = objTotal ? Math.round(((objTotal - objIssues) / objTotal) * 100) : 100;

    const avg = Math.round((fc + dup + fmt + jk + intScore) / 5);
    scores[obj] = { score: avg, breakdown: { fieldCompleteness: fc, duplicates: dup, formatConsistency: fmt, junkData: jk, dataIntegrity: intScore } };
  }

  return scores;
}

// --- 1.7 Overall Data Quality Grade ---
function calcOverallGrade(objectScores) {
  const allScores = Object.values(objectScores).map(o => o.score);
  const avg = Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length);

  let grade;
  if (avg >= 90) grade = 'A';
  else if (avg >= 75) grade = 'B';
  else if (avg >= 60) grade = 'C';
  else if (avg >= 40) grade = 'D';
  else grade = 'F';

  return { score: avg, grade };
}

// --- Utility ---
function isEmpty(val) {
  return val === null || val === undefined || (typeof val === 'string' && val.trim() === '');
}

module.exports = { runFullScan };
