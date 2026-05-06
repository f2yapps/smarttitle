/**
 * journal-recommender.js
 * Self-contained journal recommendation module for SmartTitle.
 * Pipeline: load curated journals → keyword pre-filter → LLM scope-match → OpenAlex IF verify
 */

const JournalRecommender = (function () {

  const CONFIG = {
    MAX_JOURNALS_IN_PROMPT: 60,   // after keyword pre-filter
    TOP_K:                  10,   // journals to return from LLM
    JOURNALS_DATA_URL:      'data/journals.json',
    OPENALEX_MAILTO:        'support@f2yapps.com',
  };

  let _journalsCache = null;

  // ── 1. Load curated journals ──────────────────────────────────────────────
  async function loadJournals() {
    if (_journalsCache) return _journalsCache;
    const res = await fetch(CONFIG.JOURNALS_DATA_URL);
    if (!res.ok) throw new Error('Could not load journal database.');
    _journalsCache = await res.json();
    return _journalsCache;
  }

  // ── 2. Keyword-overlap pre-filter ─────────────────────────────────────────
  // Score each journal by how many manuscript terms appear in its scope/subjects.
  // This trims the list BEFORE the LLM sees it, keeping prompt size manageable
  // while ensuring the most relevant candidates are always included.
  function selectJournalSubset(journals, manuscript) {
    const raw = [
      manuscript.title   || '',
      manuscript.abstract || '',
      (manuscript.keywords || []).join(' '),
    ].join(' ').toLowerCase();

    // Extract meaningful words (4+ chars, no stopwords)
    const STOP = new Set(['with','that','this','from','have','been','were','they',
      'their','into','also','more','than','when','which','about','such','each',
      'these','other','after','some','would','there','what','where']);
    const terms = raw.split(/\W+/).filter(w => w.length >= 4 && !STOP.has(w));
    const termSet = new Set(terms);

    const scored = journals.map(function(j) {
      const haystack = ((j.scope || '') + ' ' + (j.subjects || []).join(' ')).toLowerCase();
      let score = 0;
      termSet.forEach(function(t) {
        if (haystack.includes(t)) score++;
      });
      // Bonus: journal name words that appear in manuscript
      const nameLower = (j.name || '').toLowerCase();
      nameLower.split(/\W+/).forEach(function(w) {
        if (w.length >= 4 && termSet.has(w)) score += 3;
      });
      return { journal: j, score };
    });

    scored.sort(function(a, b) { return b.score - a.score; });
    return scored.slice(0, CONFIG.MAX_JOURNALS_IN_PROMPT).map(function(s) { return s.journal; });
  }

  // ── 3. Build LLM prompt ───────────────────────────────────────────────────
  function buildPrompt(manuscript, journals, prefs) {
    const rows = journals.map(function(j, i) {
      const oa   = j.open_access ? 'open-access' : 'subscription';
      const ifStr = j.impact_factor ? j.impact_factor.toFixed(1) : 'unknown';
      return (i + 1) + '. ' + j.name + ' | IF:' + ifStr + ' | ' + oa +
             ' | Publisher:' + (j.publisher || '') +
             ' | Scope: ' + (j.scope || '').slice(0, 120);
    }).join('\n');

    const tierDef   = prefs.tierDef;
    const ifInstr   = tierDef.key === 'any'
      ? 'No IF preference — rank purely by scope fit.'
      : 'Author prefers IF ' + tierDef.range + '. Prioritise journals in that range but scope fit overrides IF.';
    const oaInstr   = prefs.access === 'open-access' ? 'Author requires open-access only.' : 'No access restriction.';
    const mandate   = prefs.oaMandate ? '\n⚠ FUNDER MANDATE: Do not recommend subscription-only journals.' : '';
    const msType    = (prefs.paperType || 'research article').replace('-', ' ');

    const system = 'You are an expert academic publishing advisor with deep knowledge of journal aims and scope. Return only valid JSON, no markdown, no prose.';

    const user = 'Select the ' + CONFIG.TOP_K + ' journals from the candidate list that best match this manuscript.\n\n' +
      'TITLE: ' + (manuscript.title || '(not provided)') + '\n' +
      'KEYWORDS: ' + ((manuscript.keywords || []).join(', ') || '(none)') + '\n' +
      'MANUSCRIPT TYPE: ' + msType + '\n' +
      'IF PREFERENCE: ' + ifInstr + '\n' +
      'ACCESS: ' + oaInstr + mandate + '\n\n' +
      'ABSTRACT:\n"""\n' + manuscript.abstract + '\n"""\n\n' +
      'CANDIDATE JOURNALS (pre-filtered by keyword overlap):\n' + rows + '\n\n' +
      'For each selected journal, use the provided scope description AND your knowledge of the journal\'s actual aims to assess fit.\n\n' +
      'Return JSON exactly:\n' +
      '{"recommendations":[' +
        '{"name":"exact journal name from list","issn":"","score":0.0,' +
         '"fit_tags":["tag1","tag2"],' +
         '"rejection_risk":"low|medium|high",' +
         '"rejection_risk_note":"One sentence on most likely desk-rejection reason.",' +
         '"rationale":"2-sentence explanation of why scope matches this manuscript."}' +
      ']}';

    return { system, user };
  }

  // ── 4. Call backend AI proxy ──────────────────────────────────────────────
  async function callAIProxy(system, user) {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, user }),
    });
    if (!res.ok) {
      const err = await res.json().catch(function() { return {}; });
      throw new Error(err.error || 'AI request failed (' + res.status + ')');
    }
    const data = await res.json();
    const text = data.text || '';
    // Strip markdown fences if LLM adds them
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      return JSON.parse(clean);
    } catch(_) {
      // Retry: ask AI to fix its JSON
      const retry = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system,
          user: user + '\n\nIMPORTANT: Return ONLY valid JSON. No markdown. No code fences.',
        }),
      });
      const d2 = await retry.json();
      const t2 = (d2.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      return JSON.parse(t2);
    }
  }

  // ── 5. Verify IF + metadata from OpenAlex ────────────────────────────────
  async function verifyWithOpenAlex(recs, journalDb) {
    return Promise.all(recs.map(async function(r) {
      // First try the curated DB for submission_url
      const dbEntry = journalDb.find(function(j) {
        return j.name.toLowerCase().trim() === r.name.toLowerCase().trim();
      }) || journalDb.find(function(j) {
        return j.name.toLowerCase().includes(r.name.toLowerCase().slice(0, 20));
      });
      const submissionUrl = dbEntry ? dbEntry.submission_url : null;

      // Then verify IF from OpenAlex
      try {
        const q = encodeURIComponent(r.name);
        const res = await fetch(
          'https://api.openalex.org/sources?search=' + q +
          '&filter=type:journal&per-page=1' +
          '&select=id,display_name,summary_stats,homepage_url,is_oa,apc_usd,apc_prices,host_organization_name' +
          '&mailto=' + CONFIG.OPENALEX_MAILTO
        );
        if (!res.ok) throw new Error();
        const d = await res.json();
        const hit = (d.results || [])[0];
        if (!hit) throw new Error();
        const verIF = (hit.summary_stats || {})['2yr_mean_citedness'];
        const apc   = hit.apc_usd ? '$' + hit.apc_usd
                    : (hit.apc_prices && hit.apc_prices.length ? '$' + hit.apc_prices[0].price : null);
        return Object.assign({}, r, {
          impact_factor:  verIF != null ? verIF : (dbEntry ? dbEntry.impact_factor : null),
          if_verified:    verIF != null,
          access_type:    hit.is_oa === true ? 'open-access' : (hit.is_oa === false ? 'subscription' : 'hybrid'),
          apc,
          publisher:      hit.host_organization_name || (dbEntry ? dbEntry.publisher : null),
          homepage_url:   hit.homepage_url || null,
          openalex_url:   hit.id ? hit.id.replace('https://api.openalex.org/', 'https://openalex.org/') : null,
          submission_url: submissionUrl,
          open_access:    hit.is_oa === true,
        });
      } catch(_) {
        return Object.assign({}, r, {
          impact_factor:  dbEntry ? dbEntry.impact_factor : null,
          if_verified:    false,
          access_type:    dbEntry ? (dbEntry.open_access ? 'open-access' : 'subscription') : 'unknown',
          open_access:    dbEntry ? dbEntry.open_access : false,
          submission_url: submissionUrl,
        });
      }
    }));
  }

  // ── 6. Main entry point ───────────────────────────────────────────────────
  async function recommend(manuscript, prefs) {
    const journals  = await loadJournals();
    const subset    = selectJournalSubset(journals, manuscript);
    const prompt    = buildPrompt(manuscript, subset, prefs);
    const aiResult  = await callAIProxy(prompt.system, prompt.user);
    const recs      = (aiResult.recommendations || []).slice(0, CONFIG.TOP_K);
    if (recs.length === 0) throw new Error('AI returned no recommendations. Please try again.');
    const enriched  = await verifyWithOpenAlex(recs, journals);
    return enriched;
  }

  return { recommend, loadJournals, selectJournalSubset };
})();
