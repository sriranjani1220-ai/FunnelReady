// relationship-scanner.js — Feature 4: Record Relationship Audit
// Analyzes Account-Contact-Opportunity relationship integrity

async function runRelationshipScan(conn) {
  // Query all four objects once, then analyze in memory
  const accounts = await queryAll(conn, 'Account', ['Industry', 'Type']);
  const contacts = await queryAll(conn, 'Contact', ['AccountId', 'Email', 'Title']);
  const opps = await queryAll(conn, 'Opportunity', [
    'AccountId', 'StageName', 'Amount', 'IsClosed', 'IsWon'
  ]);

  // Query OpportunityContactRole (may not have records)
  let contactRoles = [];
  try {
    const crResult = await conn.query(
      'SELECT Id, OpportunityId, ContactId FROM OpportunityContactRole LIMIT 2000'
    );
    contactRoles = crResult.records || [];
  } catch (err) {
    console.log('OpportunityContactRole query failed (may not be accessible):', err.message);
  }

  // Build lookup maps
  const accountIds = new Set(accounts.map(a => a.Id));
  const contactsByAccount = buildGroupMap(contacts, 'AccountId');
  const oppsByAccount = buildGroupMap(opps, 'AccountId');
  const rolesByOpp = buildGroupMap(contactRoles, 'OpportunityId');
  const rolesByContact = buildGroupMap(contactRoles, 'ContactId');

  // Run all 7 sub-checks
  const orphanAccounts = analyzeOrphanAccounts(accounts, contactsByAccount, oppsByAccount);
  const orphanContacts = analyzeOrphanContacts(contacts, accountIds);
  const disconnectedOpps = analyzeDisconnectedOpps(opps, accountIds, contactsByAccount);
  const accountsMissingContacts = analyzeAccountsMissingContacts(accounts, contactsByAccount, oppsByAccount);
  const accountsMissingOpps = analyzeAccountsMissingOpps(accounts, contactsByAccount, oppsByAccount);
  const contactOppGaps = analyzeContactOppGaps(contacts, oppsByAccount, rolesByContact, contactRoles.length);
  const completeness = analyzeRelationshipCompleteness(accounts, contactsByAccount, oppsByAccount);

  const scores = [
    orphanAccounts.score,
    orphanContacts.score,
    disconnectedOpps.score,
    accountsMissingContacts.score,
    accountsMissingOpps.score,
    contactOppGaps.score,
    completeness.score
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
      recordCounts: {
        Accounts: accounts.length,
        Contacts: contacts.length,
        Opportunities: opps.length,
        ContactRoles: contactRoles.length
      },
      checkScores: {
        orphanAccounts: orphanAccounts.score,
        orphanContacts: orphanContacts.score,
        disconnectedOpps: disconnectedOpps.score,
        accountsMissingContacts: accountsMissingContacts.score,
        accountsMissingOpps: accountsMissingOpps.score,
        contactOppGaps: contactOppGaps.score,
        completeness: completeness.score
      }
    },
    details: {
      orphanAccounts,
      orphanContacts,
      disconnectedOpps,
      accountsMissingContacts,
      accountsMissingOpps,
      contactOppGaps,
      completeness
    }
  };
}

// --- Helpers ---

function buildGroupMap(records, keyField) {
  const map = {};
  for (const r of records) {
    const key = r[keyField];
    if (key) {
      if (!map[key]) map[key] = [];
      map[key].push(r);
    }
  }
  return map;
}

async function queryAll(conn, objectName, fields) {
  const fieldList = ['Id', 'Name', ...fields.filter(f => f !== 'Name' && f !== 'Id')];
  const uniqueFields = [...new Set(fieldList)].join(', ');
  const soql = `SELECT ${uniqueFields} FROM ${objectName} LIMIT 2000`;
  try {
    const result = await conn.query(soql);
    return result.records || [];
  } catch (err) {
    console.error(`Relationship query error for ${objectName}:`, err.message);
    return [];
  }
}

// --- 4.1 Orphan Accounts ---
// Accounts with ZERO contacts AND ZERO opportunities
function analyzeOrphanAccounts(accounts, contactsByAccount, oppsByAccount) {
  const orphans = [];

  for (const a of accounts) {
    const hasContacts = contactsByAccount[a.Id] && contactsByAccount[a.Id].length > 0;
    const hasOpps = oppsByAccount[a.Id] && oppsByAccount[a.Id].length > 0;

    if (!hasContacts && !hasOpps) {
      orphans.push({ id: a.Id, name: a.Name, industry: a.Industry || 'None', type: a.Type || 'None' });
    }
  }

  const orphanPct = accounts.length > 0 ? Math.round((orphans.length / accounts.length) * 100) : 0;
  const score = Math.max(0, Math.round(100 - orphanPct * 2.5));

  return {
    score: Math.min(100, score),
    orphanCount: orphans.length,
    orphanPct,
    orphans: orphans.slice(0, 25),
    totalAccounts: accounts.length
  };
}

// --- 4.2 Orphan Contacts ---
// Contacts with no AccountId (floating, unlinked)
function analyzeOrphanContacts(contacts, accountIds) {
  const noAccount = [];
  const brokenLink = [];

  for (const c of contacts) {
    if (!c.AccountId) {
      noAccount.push({ id: c.Id, name: c.Name, email: c.Email || 'None' });
    } else if (!accountIds.has(c.AccountId)) {
      // AccountId set but Account doesn't exist (shouldn't happen but check)
      brokenLink.push({ id: c.Id, name: c.Name, accountId: c.AccountId });
    }
  }

  const orphanPct = contacts.length > 0 ? Math.round((noAccount.length / contacts.length) * 100) : 0;
  const score = Math.max(0, Math.round(100 - orphanPct * 3));

  return {
    score: Math.min(100, score),
    noAccountCount: noAccount.length,
    brokenLinkCount: brokenLink.length,
    orphanPct,
    noAccount: noAccount.slice(0, 25),
    brokenLink: brokenLink.slice(0, 10),
    totalContacts: contacts.length
  };
}

// --- 4.3 Disconnected Opportunities ---
// Opps with no AccountId or whose Account has zero contacts
function analyzeDisconnectedOpps(opps, accountIds, contactsByAccount) {
  const noAccount = [];
  const noContactsOnAccount = [];

  for (const o of opps) {
    if (!o.AccountId) {
      noAccount.push({ id: o.Id, name: o.Name, stage: o.StageName, amount: o.Amount || 0 });
    } else if (!contactsByAccount[o.AccountId] || contactsByAccount[o.AccountId].length === 0) {
      noContactsOnAccount.push({
        id: o.Id, name: o.Name, stage: o.StageName,
        amount: o.Amount || 0, accountId: o.AccountId
      });
    }
  }

  const totalIssues = noAccount.length + noContactsOnAccount.length;
  const issuePct = opps.length > 0 ? Math.round((totalIssues / opps.length) * 100) : 0;
  const score = Math.max(0, Math.round(100 - issuePct * 2));

  return {
    score: Math.min(100, score),
    noAccountCount: noAccount.length,
    noContactsOnAccountCount: noContactsOnAccount.length,
    totalIssues,
    issuePct,
    noAccount: noAccount.slice(0, 20),
    noContactsOnAccount: noContactsOnAccount.slice(0, 20),
    totalOpps: opps.length
  };
}

// --- 4.4 Accounts Missing Contacts ---
// Accounts that have Opps but no Contacts (selling to nobody?)
function analyzeAccountsMissingContacts(accounts, contactsByAccount, oppsByAccount) {
  const missing = [];

  for (const a of accounts) {
    const hasOpps = oppsByAccount[a.Id] && oppsByAccount[a.Id].length > 0;
    const hasContacts = contactsByAccount[a.Id] && contactsByAccount[a.Id].length > 0;

    if (hasOpps && !hasContacts) {
      const accOpps = oppsByAccount[a.Id];
      missing.push({
        id: a.Id, name: a.Name,
        oppCount: accOpps.length,
        totalAmount: accOpps.reduce((sum, o) => sum + (o.Amount || 0), 0)
      });
    }
  }

  const accountsWithOpps = accounts.filter(a => oppsByAccount[a.Id] && oppsByAccount[a.Id].length > 0);
  const missingPct = accountsWithOpps.length > 0 ? Math.round((missing.length / accountsWithOpps.length) * 100) : 0;
  const score = Math.max(0, Math.round(100 - missingPct * 3));

  return {
    score: Math.min(100, score),
    missingCount: missing.length,
    missingPct,
    missing: missing.slice(0, 25),
    accountsWithOpps: accountsWithOpps.length,
    totalAccounts: accounts.length
  };
}

// --- 4.5 Accounts Missing Opportunities ---
// Accounts with Contacts but no Opps (stalled relationships)
function analyzeAccountsMissingOpps(accounts, contactsByAccount, oppsByAccount) {
  const missing = [];

  for (const a of accounts) {
    const hasContacts = contactsByAccount[a.Id] && contactsByAccount[a.Id].length > 0;
    const hasOpps = oppsByAccount[a.Id] && oppsByAccount[a.Id].length > 0;

    if (hasContacts && !hasOpps) {
      missing.push({
        id: a.Id, name: a.Name,
        contactCount: contactsByAccount[a.Id].length
      });
    }
  }

  const accountsWithContacts = accounts.filter(a => contactsByAccount[a.Id] && contactsByAccount[a.Id].length > 0);
  const missingPct = accountsWithContacts.length > 0 ? Math.round((missing.length / accountsWithContacts.length) * 100) : 0;

  // Less severe than missing contacts — some accounts are just prospects
  const score = Math.max(0, Math.round(100 - missingPct * 1.5));

  return {
    score: Math.min(100, score),
    missingCount: missing.length,
    missingPct,
    missing: missing.slice(0, 25),
    accountsWithContacts: accountsWithContacts.length,
    totalAccounts: accounts.length
  };
}

// --- 4.6 Contact-to-Opportunity Gaps ---
// Contacts whose Account has Opps but the Contact has no OpportunityContactRole
function analyzeContactOppGaps(contacts, oppsByAccount, rolesByContact, totalRoles) {
  // If no contact roles exist at all, flag it but don't harshly penalize
  if (totalRoles === 0) {
    const contactsOnAccountsWithOpps = contacts.filter(c =>
      c.AccountId && oppsByAccount[c.AccountId] && oppsByAccount[c.AccountId].length > 0
    );
    return {
      score: 40,
      noRolesAtAll: true,
      contactsWithoutRoles: contactsOnAccountsWithOpps.length,
      contactsOnOppAccounts: contactsOnAccountsWithOpps.length,
      totalContacts: contacts.length,
      gaps: [],
      message: 'No OpportunityContactRoles found. Contact Roles are not being used — this limits AI visibility into who influences deals.'
    };
  }

  const gaps = [];
  let contactsOnOppAccounts = 0;

  for (const c of contacts) {
    if (!c.AccountId) continue;
    const accountHasOpps = oppsByAccount[c.AccountId] && oppsByAccount[c.AccountId].length > 0;
    if (!accountHasOpps) continue;

    contactsOnOppAccounts++;
    const hasRole = rolesByContact[c.Id] && rolesByContact[c.Id].length > 0;
    if (!hasRole) {
      gaps.push({
        id: c.Id, name: c.Name, email: c.Email || 'None',
        accountId: c.AccountId,
        oppCount: oppsByAccount[c.AccountId].length
      });
    }
  }

  const gapPct = contactsOnOppAccounts > 0 ? Math.round((gaps.length / contactsOnOppAccounts) * 100) : 0;
  const score = Math.max(0, Math.round(100 - gapPct * 1.5));

  return {
    score: Math.min(100, score),
    noRolesAtAll: false,
    contactsWithoutRoles: gaps.length,
    contactsOnOppAccounts,
    gapPct,
    gaps: gaps.slice(0, 25),
    totalContacts: contacts.length,
    totalRoles
  };
}

// --- 4.7 Relationship Completeness ---
// What % of Accounts have the full Account -> Contact -> Opportunity chain
function analyzeRelationshipCompleteness(accounts, contactsByAccount, oppsByAccount) {
  let complete = 0;       // has both contacts AND opps
  let contactsOnly = 0;   // has contacts but no opps
  let oppsOnly = 0;       // has opps but no contacts
  let empty = 0;          // has neither

  const breakdown = [];

  for (const a of accounts) {
    const hasContacts = contactsByAccount[a.Id] && contactsByAccount[a.Id].length > 0;
    const hasOpps = oppsByAccount[a.Id] && oppsByAccount[a.Id].length > 0;

    if (hasContacts && hasOpps) {
      complete++;
    } else if (hasContacts) {
      contactsOnly++;
      breakdown.push({ id: a.Id, name: a.Name, status: 'Contacts only (no Opps)' });
    } else if (hasOpps) {
      oppsOnly++;
      breakdown.push({ id: a.Id, name: a.Name, status: 'Opps only (no Contacts)' });
    } else {
      empty++;
      breakdown.push({ id: a.Id, name: a.Name, status: 'Empty (no Contacts, no Opps)' });
    }
  }

  const completePct = accounts.length > 0 ? Math.round((complete / accounts.length) * 100) : 0;
  const score = Math.max(0, Math.min(100, Math.round(completePct * 1.1)));

  return {
    score,
    complete,
    completePct,
    contactsOnly,
    oppsOnly,
    empty,
    totalAccounts: accounts.length,
    breakdown: breakdown.slice(0, 30)
  };
}

module.exports = { runRelationshipScan };
