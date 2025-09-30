// Plain-English descriptions for tiles and reactions in the chem sim.

// --- helper: compute short-term trend from history ---
function lastN(history, n = 3) {
  if (!history || history.length < 2) return null;
  const k = Math.min(n, history.length);
  return history.slice(history.length - k);
}

function trendOf(history, field = 'temp', { eps = 0.02 } = {}) {
  const h = lastN(history, 3);
  if (!h || h.length < 2) return 'flat';
  const first = h[0], last = h[h.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return 'flat';
  const dv = (last[field] ?? 0) - (first[field] ?? 0);
  const slope = dv / dt;
  if (slope > eps) return 'up';
  if (slope < -eps) return 'down';
  return 'flat';
}

function trendLabelTemp(history) {
  const tr = trendOf(history, 'temp', { eps: 0.05 });
  if (tr === 'up') return ' (heating up)';
  if (tr === 'down') return ' (cooling)';
  return '';
}

function trendLabelPressure(history) {
  const tr = trendOf(history, 'pressure', { eps: 0.02 });
  if (tr === 'up') return 'pressure building';
  if (tr === 'down') return 'venting';
  return null;
}

function trendLabelPH(history) {
  const h = lastN(history, 3);
  if (!h || h.length < 2) return null;
  const first = h[0].pH ?? null, last = h[h.length - 1].pH ?? null;
  if (first == null || last == null) return null;
  const delta = last - first;
  if (Math.abs(delta) < 0.02) return null;
  if (last > 6.8 && last < 7.2) return 'neutralizing';
  return delta > 0 ? 'becoming more basic' : 'becoming more acidic';
}

function trendLabelGas(history) {
  const tr = trendOf(history, 'gasSum', { eps: 0.01 });
  if (tr === 'up') return 'gas building';
  if (tr === 'down') return 'gas dissipating';
  return null;
}

export function createNarrator(materialRegistry, reactions){
  const rxIndex = Object.fromEntries(reactions.map(r => [r.id, r]));

  const tag = (rx, key) => (rx.tags || []).some(t => String(t).includes(key));
  const exoLevel = (rx) => (rx.tags || []).find(t => String(t).startsWith('exothermic')) || null;

  function niceName(id){
    const m = materialRegistry?.get(id);
    if(m?.displayName) return m.displayName;
    return id.replace(/_g$|_l$|\(.*?\)|_/g, s => s === '_' ? ' ' : '').trim();
  }

  function hazardsFor(id){
    const m = materialRegistry?.get(id);
    if (!m) return [];
    const tags = new Set(m.hazardTags || []);
    if (m.flammability === 'high') tags.add('flammable');
    if (m.corrosivity === 'base' || m.corrosivity === 'acid') tags.add('caustic');
    if (m.corrosivity === 'oxidizer' || tags.has('oxidizer')) tags.add('oxidizer');
    if (m.toxicity === 'high') tags.add('toxic');
    return [...tags];
  }

  function colorWord(id){
    const m = materialRegistry?.get(id);
    return m?.color || null;
  }

  function isGasProduct(id, rx){
    const ph = rx?.phases?.[id] || materialRegistry.get(id)?.phaseSTP;
    return ph === 'g' || /(_g|\(g\))$/.test(id);
  }

  function isSolidProduct(id, rx){
    const ph = rx?.phases?.[id] || materialRegistry.get(id)?.phaseSTP;
    return ph === 's' || /\(s\)$/.test(id);
  }

  function isBasicProduct(id){
    return (materialRegistry.get(id)?.corrosivity === 'base');
  }

  function isAcidicProduct(id){
    return (materialRegistry.get(id)?.corrosivity === 'acid');
  }

  function pickActivity(tile, predicate){
    let best = null, bestScore = -Infinity;
    for(const entry of (tile._activity || [])){
      if(!entry || (entry.extent||0) <= 0) continue;
      const rx = rxIndex[entry.id];
      if(!rx) continue;
      if (predicate && !predicate(entry, rx)) continue;
      const score = entry.extent || 0;
      if (score > bestScore){ bestScore = score; best = { entry, rx }; }
    }
    return best;
  }

  function becauseTemp(tile){
    const hit = pickActivity(tile, (e, rx) => {
      const fx = rx.effects || {};
      return e.heat || (fx.heatPerUnit||0) > 0 || (rx.tags||[]).some(t=>String(t).startsWith('exothermic'));
    });
    if (!hit) return null;
    const { entry, rx } = hit;
    const reactants = Object.keys(rx.stoich?.reactants || {}).map(niceName).slice(0,2);
    const head = reactants.length === 2 ? `${reactants[0]} and ${reactants[1]}`
               : reactants.length === 1 ? reactants[0]
               : niceName(rx.id);
    return `temperature rising because ${head} react exothermically`;
  }

  function becausePH(tile, dir){
    const hit = pickActivity(tile, (e, rx) => {
      const prods = e.products || [];
      return dir === 'up'
        ? prods.some(p => isBasicProduct(p.id))
        : prods.some(p => isAcidicProduct(p.id));
    });
    if (!hit) return null;
    const { entry, rx } = hit;
    const prods = (entry.products||[]).filter(p => dir==='up' ? isBasicProduct(p.id) : isAcidicProduct(p.id));
    const label = prods.length ? niceName(prods[0].id) : 'products';
    return dir === 'up'
      ? `pH increasing because ${label} (basic) is forming`
      : `pH decreasing because ${label} (acidic) is forming`;
  }

  function becauseGas(tile){
    const hit = pickActivity(tile, (e, rx) => {
      const fx = rx.effects || {};
      if (fx.emitGas) return true;
      const prods = e.products || [];
      return prods.some(p => isGasProduct(p.id, rx)) || tag(rx, 'gas_evolution');
    });
    if (!hit) return null;
    const { entry, rx } = hit;
    let gasId = null, gasQty = 0;
    for(const p of (entry.products||[])){
      if (isGasProduct(p.id, rx)){
        const q = p.qty || 0;
        if (q > gasQty){ gasQty = q; gasId = p.id; }
      }
    }
    const gasName = gasId ? niceName(gasId) : 'gas';
    const hz = gasId ? hazardsFor(gasId) : [];
    const flair = hz.includes('flammable') ? ' (flammable)'
               : hz.includes('toxic') ? ' (toxic)'
               : hz.includes('oxidizer') ? ' (oxidizer)'
               : '';
    return `gas increasing because ${gasName}${flair} is being released`;
  }

  function becausePressure(tile){
    const hit = pickActivity(tile, (e, rx) => {
      const fx = rx.effects || {};
      if (fx.pressurePulse) return true;
      const prods = e.products || [];
      return prods.some(p => isGasProduct(p.id, rx)) || tag(rx, 'gas_evolution');
    });
    if (!hit) return null;
    const { entry, rx } = hit;
    let gasId = null, gasQty = 0;
    for(const p of (entry.products||[])){
      if (isGasProduct(p.id, rx)){
        const q = p.qty || 0;
        if (q > gasQty){ gasQty = q; gasId = p.id; }
      }
    }
    const gasName = gasId ? niceName(gasId) : 'gas';
    return `pressure building because ${gasName} is accumulating`;
  }

  function describeLimiter(limiter){
    if(!limiter || limiter === 'rate') return 'rate-limited';
    return `limited by ${niceName(limiter)}`;
  }

  function describeProducts(products, rx){
    if(!products?.length) return null;
    const sorted = [...products].sort((a,b)=>(b.qty||0)-(a.qty||0));
    const top = sorted.slice(0,3).map(p=>niceName(p.id));
    return top.join(', ');
  }

  function describeHeat(rx, fx){
    const exo = exoLevel(rx);
    if(exo || (fx?.heatPerUnit||0)>0) return 'heating the tile';
    return null;
  }

  function describeGas(rx, fx, products, tile){
    const rxSaysGas = tag(rx,'gas_evolution');
    const fxAddsGas = !!fx?.emitGas;
    let productGas = null;
    let productGasQty = 0;
    for(const p of (products||[])){
      const ph = rx.phases?.[p.id] || materialRegistry.get(p.id)?.phaseSTP;
      if(ph==='g' || /(_g|\(g\))$/.test(p.id)){
        const qty = p.qty || 0;
        if(!productGas || qty>productGasQty){
          productGas = p.id;
          productGasQty = qty;
        }
      }
    }
    const tileGas = Object.entries(tile?.gas || {})
      .filter(([,v])=>v>0.05)
      .sort((a,b)=>b[1]-a[1])[0];
    let label = null;
    if(tileGas){
      const [id,val] = tileGas;
      if(!productGas || val > productGasQty*1.25) label = id;
    }
    if(!label && productGas) label = productGas;
    if(label){
      const pretty = niceName(label);
      const htags = hazardsFor(label);
      const flair = htags.includes('flammable') ? ' (flammable)'
                : htags.includes('toxic') ? ' (toxic)'
                : htags.includes('oxidizer') ? ' (oxidizer)'
                : '';
      return `releasing ${pretty}${flair}`;
    }
    if(rxSaysGas || fxAddsGas || productGas) return 'releasing gas';
    return null;
  }

  function reactionLabel(rx){
    if(rx?.equation) return rx.equation;
    return (rx?.id || 'reaction').replace(/_/g,' ');
  }

  function buildProductionInsights(tile){
    const productions = new Map();
    for(const entry of (tile._activity||[])){
      if(!entry || (entry.extent||0)<=0) continue;
      const rx = rxIndex[entry.id];
      if(!rx) continue;
      for(const prod of entry.products||[]){
        if(!prod || (prod.qty||0)<=0) continue;
        const arr = productions.get(prod.id) || [];
        arr.push({ entry, rx, qty: prod.qty||0 });
        productions.set(prod.id, arr);
      }
    }
    const lines=[];
    for(const [prodId, sources] of productions){
      const prodName = niceName(prodId);
      const sourceLabels = [...new Set(sources.map(({rx})=>reactionLabel(rx)))];
      const {entry, rx} = sources[0];
      const limiter = entry.limiter && entry.limiter!=='rate' ? niceName(entry.limiter) : null;
      const reactants = Object.keys(rx.stoich?.reactants||{}).map(niceName);
      const increase = limiter ? `adding more ${limiter}` : (reactants.length ? `supplying more ${reactants.join(', ')}` : 'supplying more reactants');
      const decrease = reactants.length ? `removing ${reactants.join(', ')}` : 'reducing the available reactants';
      lines.push(`${prodName} is being produced by ${sourceLabels.join(' and ')}. Increase production by ${increase}. Reduce it by ${decrease}.`);
    }
    return lines;
  }

  function actorPhrase(rx){
    const rcts = Object.keys(rx.stoich?.reactants || {});
    const hasWater = rcts.some(id=>/^H2O(_g|\(g\))?$/.test(id) || id==='H2O' || id==='H2O(l)');
    const hasAcid = rcts.some(id=>{
      const m = materialRegistry.get(id);
      return m?.corrosivity==='acid' || (m?.hazardTags||[]).includes('acid');
    });
    const hasBase = rcts.some(id=>{
      const m = materialRegistry.get(id);
      return m?.corrosivity==='base' || (m?.hazardTags||[]).includes('base');
    });
    const hasMetal = rcts.some(id=>{
      const m = materialRegistry.get(id);
      return m && m.phaseSTP==='s' && (m.hazardTags||[]).includes('water_reactive');
    });

    if(hasAcid && hasBase) return 'The acid is neutralizing the base';
    if(hasMetal && hasWater) return 'The metal is reacting with water';
    if(hasAcid) return 'The acid is reacting with a reactant';
    if(hasBase) return 'The base is reacting with a reactant';
    return 'A reaction is proceeding';
  }

  function describeReactionEntry(entry){
    const rx = rxIndex[entry.id];
    if(!rx) return null;
    const fx = rx.effects || {};
    const parts = [];

    parts.push(actorPhrase(rx));

    const consequences = [];
    const heat = describeHeat(rx, fx);
    if(heat) consequences.push(heat);

    const gas = describeGas(rx, fx, entry.products, entry._tile || null);
    if(gas) consequences.push(gas);

    const prods = describeProducts(entry.products, rx);
    if (prods && !gas) {
      const solid = (entry.products || []).find(p=>{
        const ph = rx.phases?.[p.id] || materialRegistry.get(p.id)?.phaseSTP;
        return ph==='s' || /\(s\)$/.test(p.id);
      });
      if (solid) {
        const col = colorWord(solid.id);
        const label = niceName(solid.id);
        if (col) consequences.push(`forming a ${col} precipitate (${label})`);
        else consequences.push(`forming a precipitate (${label})`);
      } else {
        consequences.push(`forming ${prods}`);
      }
    } else if (prods && gas) {
      const gasName = (entry.products || []).find(p=>{
        const ph = rx.phases?.[p.id] || materialRegistry.get(p.id)?.phaseSTP;
        return ph==='g' || /(_g|\(g\))$/.test(p.id);
      });
      if(gasName){
        const noun = niceName(gasName.id);
        const idx = consequences.indexOf('releasing gas');
        if(idx>=0) consequences.splice(idx,1,`releasing ${noun}`);
      }
    }

    const limiter = describeLimiter(entry.limiter);
    const intensity = Math.round(Math.min(1, entry.extent || 0)*100);
    const consText = consequences.length ? `, ${consequences.join(' and ')}` : '';
    return `${parts[0]}${consText}. Intensity ${intensity}%, ${limiter}.`;
  }

  function summarizeTile(tile){
    const bits=[];
    let tempWord='';
    if(tile.temp>=120) tempWord='very hot';
    else if(tile.temp>=60) tempWord='hot';
    else if(tile.temp<=0) tempWord='freezing';
    else if(tile.temp<20) tempWord='cool';
    if(!tempWord) tempWord='temperate';
    const tempTrend=trendLabelTemp(tile.history);
    bits.push(tempWord+tempTrend);

    if(tile.pH<=2) bits.push('strongly acidic');
    else if(tile.pH<6) bits.push('slightly acidic');
    else if(tile.pH>8 && tile.pH<12) bits.push('slightly basic');
    else if(tile.pH>=12) bits.push('strongly basic');
    else bits.push('near neutral');

    const gasLevel = Object.values(tile.gas || {}).reduce((a,v)=>a+(v || 0),0);
    if(gasLevel>1) bits.push('gassy');
    else if(gasLevel>0.1) bits.push('traces of gas');

    if((tile.pressure || 0)>4) bits.push('pressurized');

    const pTrend = trendLabelPressure(tile.history);
    const phTrend = trendLabelPH(tile.history);
    const gTrend = trendLabelGas(tile.history);
    const trendBits = [pTrend, phTrend, gTrend].filter(Boolean);

    const head = (bits.length ? bits.join(', ') : 'stable') + (trendBits.length ? `; ${trendBits.join(', ')}` : '');

    const becauseBits = [];
    if (tempTrend.includes('heating up')) {
      const because = becauseTemp(tile);
      if (because) becauseBits.push(because);
    }
    if (pTrend === 'pressure building') {
      const because = becausePressure(tile);
      if (because) becauseBits.push(because);
    }
    if (phTrend) {
      const dir = phTrend.includes('basic') ? 'up' : phTrend.includes('acidic') ? 'down' : null;
      if (dir){
        const because = becausePH(tile, dir);
        if (because) becauseBits.push(because);
      }
    }
    if (gTrend === 'gas building') {
      const because = becauseGas(tile);
      if (because) becauseBits.push(because);
    }

    const becauseText = becauseBits.length ? ` Because: ${becauseBits.join('; ')}.` : '';

    const speciesPairs = Object.entries(tile.species||{})
      .filter(([,v])=>v>0.0001)
      .sort((a,b)=>b[1]-a[1])
      .slice(0,2)
      .map(([k])=>niceName(k));
    const speciesText = speciesPairs.length ? ` Notable species: ${speciesPairs.join(', ')}.` : '';
    return `This tile is ${head}.${becauseText}${speciesText}`;
  }

  function narrateTile(tile){
    const lines=[];
    lines.push(summarizeTile(tile));
    const acts=(tile._activity||[])
      .filter(Boolean)
      .sort((a,b)=>(b.extent||0)-(a.extent||0))
      .slice(0,3);
    for(const a of acts){
      a._tile = tile;
      const d = describeReactionEntry(a);
      if(d) lines.push(d);
    }
    const productionLines = buildProductionInsights(tile);
    lines.push(...productionLines);
    if(acts.length===0 && productionLines.length===0) lines.push('No active reactions detected.');
    return lines;
  }

  return {
    narrateTile,
    describeReactionEntry
  };
}
