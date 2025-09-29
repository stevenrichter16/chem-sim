import { subscribeHistory, unsubscribeHistory } from './history.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const SPECIES_COLORS = {
  acid: '#ff6e6b',
  base: '#5fa7ff',
  gas: '#b8ff66',
  solid: '#eaeff5',
  neutral: '#9ea9ff'
};

function clampPercent(value){
  return Math.max(0, Math.min(100, value));
}

function formatQty(value){
  if(!isFinite(value)) return '0.00';
  const abs = Math.abs(value);
  if(abs >= 10) return value.toFixed(0);
  if(abs >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

function colorForSpecies(id, bag, materialRegistry){
  if(bag === 'gas') return SPECIES_COLORS.gas;
  if(bag === 'solids') return SPECIES_COLORS.solid;
  const mat = materialRegistry?.get(id);
  const corrosivity = mat?.corrosivity || '';
  const tags = mat?.hazardTags || [];
  if(tags.includes('acid') || /acid/.test(corrosivity)) return SPECIES_COLORS.acid;
  if(tags.includes('base') || /base/.test(corrosivity)) return SPECIES_COLORS.base;
  if(mat?.phaseSTP === 'g' || /(_g|\(g\))$/.test(id)) return SPECIES_COLORS.gas;
  if(mat?.phaseSTP === 's' || /\(s\)$/.test(id)) return SPECIES_COLORS.solid;
  return SPECIES_COLORS.neutral;
}

function buildSparklineData(history){
  if(!history || history.length < 2) return null;
  const width = 200;
  const height = 60;
  const pad = 4;
  const minT = history[0].t;
  const maxT = history[history.length - 1].t;
  const span = Math.max(1, maxT - minT);
  const temps = history.map(h => h.temp);
  const presses = history.map(h => (h.pressure || 0));
  const minTemp = Math.min(...temps);
  const maxTemp = Math.max(...temps);
  const minPress = Math.min(...presses);
  const maxPress = Math.max(...presses);
  const mapPoints = (values, minVal, maxVal) => values.map((v, i) => {
    const x = pad + ((history[i].t - minT) / span) * (width - 2 * pad);
    const range = maxVal - minVal;
    const ratio = range ? ((v - minVal) / range) : 0.5;
    const y = height - pad - ratio * (height - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return {
    tempPoints: mapPoints(temps, minTemp, maxTemp),
    pressurePoints: mapPoints(presses, minPress, maxPress),
    tempLabel: `${temps[temps.length - 1].toFixed(1)}°C`,
    pressureLabel: `${(presses[presses.length - 1]).toFixed(2)}`
  };
}

function createPanel(root, title){
  const section = document.createElement('section');
  section.className = 'panel';
  const heading = document.createElement('h4');
  heading.textContent = title;
  section.appendChild(heading);
  const body = document.createElement('div');
  section.appendChild(body);
  root.appendChild(section);
  return { section, body };
}

export class InspectorComponent {
  constructor(container, materialRegistry){
    this.container = container;
    this.materialRegistry = materialRegistry;
    this.focus = null;
    this.lastTileKey = null;
    this.lastStats = null;
    this.lastReactionsSig = '';
    this.lastSpeciesSig = '';
    this.lastGasSig = '';
    this.lastSolidSig = '';
    this.lastSparkSig = '';
    this._build();
    this._showPlaceholder();
  }

  _build(){
    this.container.innerHTML = '';
    this.root = document.createElement('div');
    this.container.appendChild(this.root);

    this.placeholder = document.createElement('section');
    this.placeholder.className = 'panel';
    this.placeholder.innerHTML = '<h4>Inspector</h4><div class="muted">No tile selected</div>';
    this.root.appendChild(this.placeholder);

    this.detail = document.createElement('div');
    this.detail.className = 'inspector-detail';
    this.root.appendChild(this.detail);

    // Tile panel
    this.tilePanel = document.createElement('section');
    this.tilePanel.className = 'panel tile-panel';
    this.detail.appendChild(this.tilePanel);

    const metaRow = document.createElement('div');
    metaRow.className = 'tile-meta-row';
    this.tileTitle = document.createElement('h3');
    metaRow.appendChild(this.tileTitle);
    this.tileSubtitle = document.createElement('span');
    this.tileSubtitle.className = 'muted';
    this.tileSubtitle.textContent = 'Last 10s trends';
    metaRow.appendChild(this.tileSubtitle);
    this.tilePanel.appendChild(metaRow);

    this.sparklineWrap = document.createElement('div');
    this.sparklineWrap.className = 'sparkline-wrap';
    this.tilePanel.appendChild(this.sparklineWrap);

    this.sparklineSVG = document.createElementNS(SVG_NS, 'svg');
    this.sparklineSVG.setAttribute('class', 'sparkline');
    this.sparklineSVG.setAttribute('viewBox', '0 0 200 60');
    this.sparklineSVG.setAttribute('preserveAspectRatio', 'none');
    this.sparklineWrap.appendChild(this.sparklineSVG);

    this.tempPolyline = document.createElementNS(SVG_NS, 'polyline');
    this.tempPolyline.setAttribute('class', 'temp');
    this.sparklineSVG.appendChild(this.tempPolyline);

    this.pressurePolyline = document.createElementNS(SVG_NS, 'polyline');
    this.pressurePolyline.setAttribute('class', 'pressure');
    this.sparklineSVG.appendChild(this.pressurePolyline);

    this.sparklineLegend = document.createElement('div');
    this.sparklineLegend.className = 'sparkline-legend';
    this.tempLegendEntry = document.createElement('span');
    this.tempLegendEntry.className = 'temp-dot';
    this.sparklineLegend.appendChild(this.tempLegendEntry);
    this.pressureLegendEntry = document.createElement('span');
    this.pressureLegendEntry.className = 'pressure-dot';
    this.sparklineLegend.appendChild(this.pressureLegendEntry);
    this.sparklineWrap.appendChild(this.sparklineLegend);

    this.sparklineEmpty = document.createElement('div');
    this.sparklineEmpty.className = 'sparkline-legend muted';
    this.sparklineEmpty.textContent = 'Collecting history…';
    this.sparklineWrap.appendChild(this.sparklineEmpty);

    this.statsGrid = document.createElement('div');
    this.statsGrid.className = 'stats-grid';
    this.tilePanel.appendChild(this.statsGrid);

    this.stats = {};
    const tempRow = this._createStatRow('Temp', '°C');
    this.statsGrid.appendChild(tempRow.container);
    this.stats.temp = tempRow;

    const pHRow = this._createStatRow('pH');
    this.statsGrid.appendChild(pHRow.container);
    this.stats.pH = pHRow;

    const moistureRow = this._createStatRow('Moisture', '%');
    this.statsGrid.appendChild(moistureRow.container);
    this.stats.moisture = moistureRow;

    const pressureRow = this._createStatRow('Pressure');
    this.statsGrid.appendChild(pressureRow.container);
    this.stats.pressure = pressureRow;

    const reactions = createPanel(this.detail, 'Active Reactions');
    this.reactionsContainer = reactions.body;

    const speciesPanel = createPanel(this.detail, 'Species (aq)');
    this.speciesContainer = speciesPanel.body;

    const gasPanel = createPanel(this.detail, 'Gases');
    this.gasContainer = gasPanel.body;

    const solidPanel = createPanel(this.detail, 'Solids');
    this.solidContainer = solidPanel.body;
  }

  _createStatRow(label, unitSuffix=''){
    const container = document.createElement('div');
    container.className = 'stat';
    container.appendChild(document.createTextNode(label));
    const barTrack = document.createElement('div');
    barTrack.className = 'bar';
    const bar = document.createElement('i');
    barTrack.appendChild(bar);
    container.appendChild(barTrack);
    const value = document.createElement('small');
    container.appendChild(value);
    return { container, bar, value, unitSuffix };
  }

  _showPlaceholder(){
    this.placeholder.style.display = '';
    this.detail.style.display = 'none';
  }

  _showDetail(){
    this.placeholder.style.display = 'none';
    this.detail.style.display = '';
  }

  select(world, x, y){
    const tile = world.tile(x, y);
    if(!tile){
      this.clear(world);
      return null;
    }
    if(this.focus){
      const prev = world.tile(this.focus.x, this.focus.y);
      if(prev && prev !== tile){
        unsubscribeHistory(prev);
      }
    }
    subscribeHistory(tile);
    this.focus = { x, y };
    this._updateTile(tile, this.focus);
    return tile;
  }

  refresh(world){
    if(!this.focus) return;
    const tile = world.tile(this.focus.x, this.focus.y);
    if(!tile){
      this.clear(world);
      return;
    }
    this._updateTile(tile, this.focus);
  }

  onWorldCleared(world){
    this.lastStats = null;
    this.lastReactionsSig = '';
    this.lastSpeciesSig = '';
    this.lastGasSig = '';
    this.lastSolidSig = '';
    this.lastSparkSig = '';
    if(this.focus){
      const tile = world.tile(this.focus.x, this.focus.y);
      if(tile){
        subscribeHistory(tile);
        this._updateTile(tile, this.focus);
        return;
      }
    }
    this.focus = null;
    this._showPlaceholder();
  }

  clear(world){
    if(this.focus){
      const tile = world.tile(this.focus.x, this.focus.y);
      if(tile) unsubscribeHistory(tile);
    }
    this.focus = null;
    this.lastTileKey = null;
    this.lastStats = null;
    this.lastReactionsSig = '';
    this.lastSpeciesSig = '';
    this.lastGasSig = '';
    this.lastSolidSig = '';
    this.lastSparkSig = '';
    this._showPlaceholder();
  }

  _updateTile(tile, coords){
    const key = `${coords.x},${coords.y}`;
    if(this.lastTileKey !== key){
      this.lastStats = null;
      this.lastReactionsSig = '';
      this.lastSpeciesSig = '';
      this.lastGasSig = '';
      this.lastSolidSig = '';
      this.lastSparkSig = '';
      this.lastTileKey = key;
    }
    this._showDetail();
    this.tileTitle.textContent = `Tile (${coords.x},${coords.y})`;
    this._updateStats(tile);
    this._updateSparkline(tile.history);
    this._updateReactions(tile);
    this._updateSpeciesList(this.speciesContainer, tile.species, 'species', sig => this.lastSpeciesSig = sig, this.lastSpeciesSig);
    this._updateSpeciesList(this.gasContainer, tile.gas, 'gas', sig => this.lastGasSig = sig, this.lastGasSig);
    this._updateSpeciesList(this.solidContainer, tile.solids, 'solids', sig => this.lastSolidSig = sig, this.lastSolidSig);
  }

  _updateStats(tile){
    const snapshot = this.lastStats || {};
    const temp = tile.temp;
    const pH = tile.pH;
    const moisture = tile.moisture;
    const pressure = tile.pressure || 0;
    if(!this.lastStats || Math.abs(temp - snapshot.temp) > 0.05){
      this.stats.temp.bar.style.width = `${clampPercent((temp - 20) / 5)}%`;
      this.stats.temp.value.textContent = `${temp.toFixed(1)}${this.stats.temp.unitSuffix}`;
    }
    if(!this.lastStats || Math.abs(pH - snapshot.pH) > 0.01){
      this.stats.pH.bar.style.width = `${clampPercent((pH / 14) * 100)}%`;
      this.stats.pH.value.textContent = pH.toFixed(2);
    }
    if(!this.lastStats || Math.abs(moisture - snapshot.moisture) > 0.01){
      this.stats.moisture.bar.style.width = `${clampPercent(moisture * 100)}%`;
      this.stats.moisture.value.textContent = `${(moisture * 100 | 0)}%`;
    }
    if(!this.lastStats || Math.abs(pressure - snapshot.pressure) > 0.01){
      this.stats.pressure.bar.style.width = `${clampPercent((pressure / 12) * 100)}%`;
      this.stats.pressure.value.textContent = pressure.toFixed(2);
    }
    this.lastStats = { temp, pH, moisture, pressure };
  }

  _updateSparkline(history){
    const data = buildSparklineData(history);
    if(!data){
      this.sparklineSVG.style.display = 'none';
      this.sparklineLegend.style.display = 'none';
      this.sparklineEmpty.style.display = '';
      this.lastSparkSig = '';
      return;
    }
    const signature = `${data.tempPoints}|${data.pressurePoints}|${data.tempLabel}|${data.pressureLabel}`;
    if(signature !== this.lastSparkSig){
      this.tempPolyline.setAttribute('points', data.tempPoints);
      this.pressurePolyline.setAttribute('points', data.pressurePoints);
      this.tempLegendEntry.textContent = `Temp ${data.tempLabel}`;
      this.pressureLegendEntry.textContent = `Pressure ${data.pressureLabel}`;
      this.lastSparkSig = signature;
    }
    this.sparklineSVG.style.display = '';
    this.sparklineLegend.style.display = '';
    this.sparklineEmpty.style.display = 'none';
  }

  _updateReactions(tile){
    const list = (tile._activity || []).filter(Boolean);
    if(!list.length){
      if(this.lastReactionsSig !== 'empty'){
        this.reactionsContainer.innerHTML = '<div class="muted">No active reactions</div>';
        this.lastReactionsSig = 'empty';
      }
      return;
    }
    const sorted = [...list].sort((a,b)=>(b.extent || 0) - (a.extent || 0)).slice(0,5);
    const signature = JSON.stringify(sorted.map(item => [
      item.id,
      Number((item.extent || 0).toFixed(3)),
      item.limiter || '',
      !!item.fizz,
      !!item.heat,
      (item.products || []).map(p => [p.id, Number((p.qty || 0).toFixed(3))])
    ]));
    if(signature === this.lastReactionsSig) return;
    this.lastReactionsSig = signature;
    const markup = sorted.map(info => {
      const percent = Math.round(Math.min(1, info.extent || 0) * 100);
      const limiterLabel = info.limiter && info.limiter !== 'rate' ? info.limiter : 'rate-limited';
      const icons = `${info.fizz ? '<span class="icon" title="Gas evolution">⚡</span>' : ''}${info.heat ? '<span class="icon" title="Exothermic heat spike">🔥</span>' : ''}`;
      const products = (info.products || []).sort((a,b)=>(b.qty || 0) - (a.qty || 0)).slice(0,4)
        .map(p => `${p.id} (${formatQty(p.qty || 0)})`).join(', ') || '—';
      return `
        <div class="reaction">
          <header><span class="rxid">${info.id}</span><span class="icons">${icons}</span></header>
          <div class="meter"><i style="width:${percent}%"></i></div>
          <div class="meta"><strong>Intensity</strong><span>${percent}%</span></div>
          <div class="meta"><strong>Limiter</strong><span>${limiterLabel}</span></div>
          <div class="meta"><strong>Products</strong><span>${products}</span></div>
        </div>`;
    }).join('');
    this.reactionsContainer.innerHTML = markup;
  }

  _updateSpeciesList(container, entries, bag, setSignature, currentSignature){
    const items = Object.entries(entries || {})
      .filter(([, value]) => value > 0.0001)
      .sort((a,b) => b[1] - a[1])
      .slice(0,8);
    if(!items.length){
      if(currentSignature !== `${bag}-empty`){
        container.innerHTML = '<div class="muted">None</div>';
        setSignature(`${bag}-empty`);
      }
      return;
    }
    const signature = JSON.stringify(items.map(([id, value]) => [id, Number(value.toFixed(3))]));
    if(signature === currentSignature) return;
    const markup = items.map(([id, value]) => {
      const width = clampPercent(Math.max(4, (value / items[0][1]) * 100));
      const color = colorForSpecies(id, bag, this.materialRegistry);
      return `<div class="bar-row"><span class="label">${id}</span><div class="bar-track"><i style="width:${width}%; background:${color};"></i></div><span class="value">${formatQty(value)}</span></div>`;
    }).join('');
    container.innerHTML = markup;
    setSignature(signature);
  }
}
