const https = require('https');

function apiRequest(method, path, apiKey, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.smartsheet.com',
      path: '/2.0/' + path,
      method,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Trim to remove any accidental whitespace in Netlify env var values
  const API_KEY  = (process.env.SMARTSHEET_API_KEY  || '').trim();
  const SHEET_ID = (process.env.SMARTSHEET_SHEET_ID || '').trim();

  if (!API_KEY || !SHEET_ID) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({
        error: 'Server not configured',
        hint: 'SMARTSHEET_API_KEY and SMARTSHEET_SHEET_ID must be set in Netlify environment variables',
        hasKey: !!process.env.SMARTSHEET_API_KEY,
        hasSheet: !!process.env.SMARTSHEET_SHEET_ID,
      }),
    };
  }

  let payload;
  try { payload = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action } = payload;

  // ── GET COLUMNS / PING ───────────────────────────────────────
  if (action === 'getColumns' || action === 'ping') {
    const res = await apiRequest('GET', 'sheets/' + SHEET_ID + '?include=columns', API_KEY);
    if (res.status !== 200) {
      return {
        statusCode: res.status, headers,
        body: JSON.stringify({
          error: 'Smartsheet API error',
          hint: res.body && res.body.message ? res.body.message : 'Check your API key and Sheet ID in Netlify env vars',
          detail: res.body,
        }),
      };
    }
    const columns = (res.body.columns || []).map(c => ({
      id: String(c.id), title: c.title, type: c.type,
    }));
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ ok: true, sheetName: res.body.name, columnCount: columns.length, columns }),
    };
  }

  // ── SAVE QUOTE ───────────────────────────────────────────────
  if (action === 'saveQuote') {
    const { quote, items, rowId, columnMap, appUrl } = payload;

    const quotePayload = {
      series:   quote.series,
      model:    quote.model,
      customer: quote.customer,
      snap:     quote.snap,
      discount: quote.discount,
      delivery: quote.delivery,
    };

    const quoteLink = appUrl
      ? appUrl + '?q=' + encodeURIComponent(Buffer.from(JSON.stringify(quotePayload)).toString('base64'))
      : '';

    const optionsList = (items || [])
      .map(i => i.name + (i.qty > 1 ? ' x' + i.qty : ''))
      .join(', ');

    const cells = [
      { columnId: Number(columnMap.DATE),          value: quote.date },
      { columnId: Number(columnMap.SERIES),        value: quote.series },
      { columnId: Number(columnMap.MODEL),         value: quote.model },
      { columnId: Number(columnMap.CUSTOMER_NAME), value: (quote.customer && quote.customer.name)     || '' },
      { columnId: Number(columnMap.EMAIL),         value: (quote.customer && quote.customer.email)    || '' },
      { columnId: Number(columnMap.MOBILE),        value: (quote.customer && quote.customer.mobile)   || '' },
      { columnId: Number(columnMap.POSTCODE),      value: (quote.customer && quote.customer.postcode) || '' },
      { columnId: Number(columnMap.BASE_PRICE),    value: quote.base },
      { columnId: Number(columnMap.OPTIONS_TOTAL), value: quote.optsTotal },
      { columnId: Number(columnMap.DELIVERY),      value: quote.delivery },
      { columnId: Number(columnMap.DISCOUNT),      value: quote.discount || 0 },
      { columnId: Number(columnMap.GRAND_TOTAL),   value: quote.grand },
      { columnId: Number(columnMap.OPTIONS_LIST),  value: optionsList },
      { columnId: Number(columnMap.QUOTE_LINK),    value: quoteLink },
      { columnId: Number(columnMap.QUOTE_JSON),    value: JSON.stringify(quotePayload) },
    ].filter(c => c.columnId && !isNaN(c.columnId));

    let res;
    if (rowId) {
      res = await apiRequest('PUT', 'sheets/' + SHEET_ID + '/rows', API_KEY, [{ id: Number(rowId), cells }]);
    } else {
      res = await apiRequest('POST', 'sheets/' + SHEET_ID + '/rows', API_KEY, [{ toBottom: true, cells }]);
    }

    if (res.status !== 200 && res.status !== 201) {
      return {
        statusCode: res.status, headers,
        body: JSON.stringify({
          error: 'Save failed',
          hint: res.body && res.body.message ? res.body.message : 'Unknown error',
          detail: res.body,
        }),
      };
    }

    const savedRow = Array.isArray(res.body.result) ? res.body.result[0] : res.body.result;
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ ok: true, rowId: String((savedRow && savedRow.id) ? savedRow.id : rowId || '') }),
    };
  }

  // ── SEARCH BY MOBILE ─────────────────────────────────────────
  if (action === 'searchByMobile') {
    const { mobile, columnMap } = payload;

    const res = await apiRequest('GET', 'sheets/' + SHEET_ID + '?include=rows', API_KEY);
    if (res.status !== 200) {
      return {
        statusCode: res.status, headers,
        body: JSON.stringify({
          error: 'Fetch failed',
          hint: res.body && res.body.message ? res.body.message : 'Unknown error',
        }),
      };
    }

    const sheet       = res.body;
    const mobileColId = String(columnMap.MOBILE);
    const clean       = function(str) { return String(str || '').replace(/\s+/g, ''); };

    const matchingRows = (sheet.rows || []).filter(function(row) {
      return row.cells.some(function(c) {
        return String(c.columnId) === mobileColId && clean(c.value) === clean(mobile);
      });
    });

    const quotes = matchingRows.map(function(row) {
      const get = function(key) {
        const colId = columnMap[key];
        if (!colId) return null;
        const cell = row.cells.find(function(c) { return String(c.columnId) === String(colId); });
        return cell ? cell.value : null;
      };

      let quoteJson = get('QUOTE_JSON');
      if (quoteJson && typeof quoteJson === 'string') {
        try { quoteJson = JSON.parse(quoteJson); } catch(e) {}
      }

      return {
        rowId:      String(row.id),
        date:       get('DATE'),
        series:     get('SERIES'),
        model:      get('MODEL'),
        name:       get('CUSTOMER_NAME'),
        email:      get('EMAIL'),
        mobile:     get('MOBILE'),
        postcode:   get('POSTCODE'),
        grandTotal: get('GRAND_TOTAL'),
        quoteJson,
      };
    });

    // Most recent first
    quotes.reverse();

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ ok: true, quotes }),
    };
  }

  return {
    statusCode: 400, headers,
    body: JSON.stringify({ error: 'Unknown action: ' + action }),
  };
};
