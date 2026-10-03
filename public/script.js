(() => {
  const TOKEN_KEY = 'gcoin.accessToken';
  const API_BASE = 'https://gcoin-backend.onrender.com';
  const API = `${API_BASE}/api`;
  const MILESTONE_POINTS = [1000, 3000, 5000, 7000, 9000];
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const authView = document.getElementById('auth-view');
  const dashboardView = document.getElementById('dashboard-view');
  const authForm = document.getElementById('auth-form');
  const authMessage = document.getElementById('auth-message');
  const nodeForm = document.getElementById('node-form');
  const nodeMessage = document.getElementById('node-message');
  const dashboardMessage = document.getElementById('dashboard-message');
  const toast = document.getElementById('toast');
  const userLabel = document.getElementById('user-label');
  const logoutButton = document.getElementById('logout-button');
  const tokenDialog = document.getElementById('token-dialog');
  const tokenValue = document.getElementById('node-token-value');
  const tokenCopyMessage = document.getElementById('token-copy-message');
  const trailPath = document.getElementById('progress-trail');
  const progressTrail = trailPath;
  const thousandMarkers = document.getElementById('thousand-markers');
  const milestoneRoadmap = document.getElementById('milestone-roadmap');
  const milestoneMarkers = document.getElementById('milestone-markers');
  const auraNodeMatrix = document.getElementById('aura-node-matrix');
  const rouletteWheel = document.getElementById('roulette-wheel');
  const spinButton = document.getElementById('spin-button');
  const rouletteMessage = document.getElementById('roulette-message');
  const rouletteResult = document.getElementById('roulette-result');
  const walletForm = document.getElementById('wallet-form');
  const payoutWallet = document.getElementById('payout-wallet');
  const payoutMessage = document.getElementById('payout-message');
  const withdrawButton = document.getElementById('withdraw-button');
  const withdrawalList = document.getElementById('withdrawal-list');

  let authMode = 'login';
  let pointsCycle = null;
  let currentUser = null;
  let refreshTimer = null;
  let toastTimer = null;
  let wheelRotation = 0;
  let spinInProgress = false;
  let lastClaimed = new Set();

  const formatNumber = (value, maximumFractionDigits = 2) =>
    new Intl.NumberFormat('es-PY', { maximumFractionDigits }).format(Number(value) || 0);
  const formatUsd = (value) => new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(Number(value) || 0);

  const svgIcon = (symbol, className, label = '') => {
    const icon = document.createElementNS(svgNamespace, 'svg');
    icon.setAttribute('class', className);
    icon.setAttribute('viewBox', '0 0 48 48');
    icon.setAttribute('aria-hidden', label ? 'false' : 'true');
    if (label) {
      icon.setAttribute('role', 'img');
      icon.setAttribute('aria-label', label);
    }
    const use = document.createElementNS(svgNamespace, 'use');
    use.setAttribute('href', `#${symbol}`);
    icon.append(use);
    return icon;
  };

  const apiRequest = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const response = await fetch(new URL(url, API_BASE), { ...options, headers });
    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        clearSession(false);
      }
      throw new Error(data.error || 'No se pudo completar la solicitud.');
    }
    return data;
  };

  const setMessage = (element, message = '', kind = '') => {
    element.textContent = message;
    element.classList.toggle('error', kind === 'error');
    element.classList.toggle('success', kind === 'success');
  };

  const showToast = (message) => {
    toast.textContent = message;
    toast.classList.remove('hidden');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.add('hidden'), 5000);
  };

  const createRequestId = () => {
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }

    if (!crypto.getRandomValues) {
      throw new Error('Este navegador no puede generar una solicitud segura para el giro.');
    }

    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  const clearSession = (showMessage = true) => {
    sessionStorage.removeItem(TOKEN_KEY);
    currentUser = null;
    pointsCycle = null;
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
    showAuthView();
    setMessage(authMessage, '');
    if (showMessage) {
      setMessage(authMessage, 'Tu sesión terminó. Vuelve a iniciar sesión.', 'error');
    }
  };

  const showAuthView = () => {
    authView.classList.remove('hidden');
    dashboardView.classList.add('hidden');
    userLabel.classList.add('hidden');
    logoutButton.classList.add('hidden');
    setMessage(dashboardMessage, '');
  };

  const showDashboardView = (username) => {
    currentUser = username;
    authView.classList.add('hidden');
    dashboardView.classList.remove('hidden');
    userLabel.textContent = username;
    userLabel.classList.remove('hidden');
    logoutButton.classList.remove('hidden');
  };

  const renderMilestones = (milestones = []) => {
    milestoneRoadmap.replaceChildren();
    const claimedNow = new Set();
    milestones.forEach((milestone) => {
      if (milestone.claimed) {
        claimedNow.add(milestone.points);
      }

      const card = document.createElement('article');
      card.className = `milestone-card${milestone.claimed ? ' unlocked' : ''}`;

      const top = document.createElement('div');
      top.className = 'milestone-top';
      const points = document.createElement('span');
      points.className = 'milestone-points';
      points.textContent = `${formatNumber(milestone.points, 0)} pts`;
      const gems = document.createElement('span');
      gems.className = 'milestone-gem';
      gems.textContent = `✧ ${formatNumber(milestone.gems, 0)}`;
      top.append(points, gems);

      const name = document.createElement('p');
      name.className = 'milestone-name';
      name.textContent = milestone.label;
      const status = document.createElement('span');
      status.className = 'milestone-status';
      status.textContent = milestone.claimed ? 'Gemas acreditadas' : 'Por descubrir';
      card.append(top, name, status);
      milestoneRoadmap.append(card);
    });

    document.getElementById('milestone-summary').textContent =
      `${claimedNow.size} de ${milestones.length} hitos desbloqueados`;
    const nextMilestone = milestones.find((milestone) =>
      !milestone.claimed && Number(pointsCycle?.pointsToday || 0) < milestone.points,
    );
    document.getElementById('top-gems-next').textContent = nextMilestone
      ? `${formatNumber(nextMilestone.points, 0)} pts`
      : 'Todos alcanzados';
    document.getElementById('top-gems-next-reward').textContent = nextMilestone
      ? `+${formatNumber(nextMilestone.gems, 0)} gemas automáticas`
      : 'Hitos acreditados';

    if (pointsCycle !== null && milestones.length) {
      updateScene(pointsCycle.pointsToday, pointsCycle.dailyLimit, milestones);
    }

    const newClaims = [...claimedNow].filter((points) => !lastClaimed.has(points));
    if (lastClaimed.size && newClaims.length) {
      const newlyEarnedGems = milestones
        .filter((milestone) => newClaims.includes(milestone.points))
        .reduce((sum, milestone) => sum + milestone.gems, 0);
      showToast(`¡Nuevo hito! Se acreditaron ${formatNumber(newlyEarnedGems, 0)} gemas.`);
      document.getElementById('top-gems-credit').textContent =
        `+${formatNumber(newlyEarnedGems, 0)} acreditadas automáticamente`;
      document.querySelector('.top-gem-balance').classList.remove('gem-credit-pulse');
      requestAnimationFrame(() =>
        document.querySelector('.top-gem-balance').classList.add('gem-credit-pulse'),
      );
    }
    lastClaimed = claimedNow;
  };

  const pointOnTrail = (progress) => {
    const length = trailPath.getTotalLength();
    return trailPath.getPointAtLength(Math.max(0, Math.min(1, progress)) * length);
  };

  const renderSceneMarkers = (milestones, limit) => {
    milestoneMarkers.replaceChildren();
    milestones.forEach((milestone) => {
      const position = pointOnTrail(milestone.points / limit);
      const group = document.createElementNS(svgNamespace, 'g');
      group.setAttribute('transform', `translate(${position.x} ${position.y})`);

      const circle = document.createElementNS(svgNamespace, 'circle');
      circle.setAttribute('r', milestone.claimed ? '7' : '4');
      circle.setAttribute('fill', milestone.claimed ? '#f3cf7e' : '#5d755f');
      circle.setAttribute('stroke', milestone.claimed ? '#fff0bd' : '#a5ad83');
      circle.setAttribute('stroke-width', '1.5');
      if (milestone.claimed) {
        circle.setAttribute('filter', 'url(#gold-glow)');
      }
      const title = document.createElementNS(svgNamespace, 'title');
      title.textContent = `${formatNumber(milestone.points, 0)} puntos · ${milestone.label}`;
      group.append(circle, title);
      milestoneMarkers.append(group);
    });
  };

  const renderThousandMarkers = (limit) => {
    thousandMarkers.replaceChildren();
    const trailLength = trailPath.getTotalLength();
    const labelBoxes = [];
    const labelWidth = 66;
    const labelHeight = 21;

    for (let points = 1000, index = 0; points <= limit; points += 1000, index += 1) {
      const distance = (points / limit) * trailLength;
      const position = trailPath.getPointAtLength(distance);
      const before = trailPath.getPointAtLength(Math.max(0, distance - 8));
      const after = trailPath.getPointAtLength(Math.min(trailLength, distance + 8));
      const tangentX = after.x - before.x;
      const tangentY = after.y - before.y;
      const tangentLength = Math.hypot(tangentX, tangentY) || 1;
      const normalX = -tangentY / tangentLength;
      const normalY = tangentX / tangentLength;
      const preferredSide = index % 2 === 0 ? -1 : 1;
      const candidates = [preferredSide, -preferredSide].flatMap((side) =>
        [34, 46, 58].map((offset) => ({
          x: position.x + normalX * side * offset,
          y: position.y + normalY * side * offset,
        })),
      );
      const fitsScene = ({ x, y }) =>
        x - labelWidth / 2 >= 6 &&
        x + labelWidth / 2 <= 994 &&
        y - labelHeight / 2 >= 6 &&
        y + labelHeight / 2 <= 554;
      const overlapsLabel = ({ x, y }) => labelBoxes.some((box) =>
        Math.abs(x - box.x) < labelWidth + 5 &&
        Math.abs(y - box.y) < labelHeight + 5,
      );
      const labelPosition = candidates.find((candidate) =>
        fitsScene(candidate) && !overlapsLabel(candidate),
      ) || candidates.find(fitsScene) || candidates[0];

      labelBoxes.push(labelPosition);
      const group = document.createElementNS(svgNamespace, 'g');
      group.setAttribute('class', 'thousand-marker');
      group.setAttribute('transform', `translate(${position.x} ${position.y})`);

      const leader = document.createElementNS(svgNamespace, 'line');
      leader.setAttribute('class', 'thousand-marker-leader');
      const leaderLength = Math.hypot(labelPosition.x - position.x, labelPosition.y - position.y) || 1;
      leader.setAttribute('x1', String(((labelPosition.x - position.x) / leaderLength) * 5));
      leader.setAttribute('y1', String(((labelPosition.y - position.y) / leaderLength) * 5));
      leader.setAttribute('x2', String(labelPosition.x - position.x));
      leader.setAttribute('y2', String(labelPosition.y - position.y));
      const marker = document.createElementNS(svgNamespace, 'circle');
      marker.setAttribute('class', 'thousand-marker-dot');
      marker.setAttribute('r', '3.5');
      const labelBox = document.createElementNS(svgNamespace, 'rect');
      labelBox.setAttribute('class', 'thousand-marker-label-box');
      labelBox.setAttribute('x', String(labelPosition.x - position.x - labelWidth / 2));
      labelBox.setAttribute('y', String(labelPosition.y - position.y - labelHeight / 2));
      labelBox.setAttribute('width', String(labelWidth));
      labelBox.setAttribute('height', String(labelHeight));
      labelBox.setAttribute('rx', '6');
      const label = document.createElementNS(svgNamespace, 'text');
      label.setAttribute('class', 'thousand-marker-label');
      label.setAttribute('x', String(labelPosition.x - position.x));
      label.setAttribute('y', String(labelPosition.y - position.y + 3.5));
      label.textContent = formatNumber(points, 0);
      const title = document.createElementNS(svgNamespace, 'title');
      title.textContent = `Hito de ${formatNumber(points, 0)} puntos`;

      group.append(leader, marker, labelBox, label, title);
      thousandMarkers.append(group);
    }
  };

  const updateEnvironmentCycle = () => {
    const hour = Number(new Intl.DateTimeFormat('es-PY', {
      timeZone: 'America/Asuncion',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()));
    const isDay = hour >= 6 && hour < 18;
    document.body.dataset.environment = isDay ? 'day' : 'night';
    document.getElementById('environment-cycle').textContent =
      `Gcoin Guaraní — ${isDay ? 'DÍA' : 'NOCHE'}`;
  };

  const updateScene = (points, limit, milestones) => {
    const progress = Math.max(0, Math.min(1, points / limit));
    const trailLength = progressTrail.getTotalLength();
    progressTrail.style.strokeDasharray = `${trailLength} ${trailLength}`;
    progressTrail.style.strokeDashoffset = String(trailLength * (1 - progress));

    const climberPosition = pointOnTrail(progress);
    document.getElementById('climber').setAttribute(
      'transform',
      `translate(${climberPosition.x} ${climberPosition.y})`,
    );
    renderSceneMarkers(milestones, limit);
    renderThousandMarkers(limit);

    const activeHito = [...milestones].reverse().find((milestone) => points >= milestone.points);
    document.getElementById('landscape-progress').textContent = points >= limit
      ? 'TOPE DEL CICLO'
      : activeHito
        ? activeHito.label.toLocaleUpperCase('es')
        : points > 0
          ? 'EL CAMINO COBRA VIDA'
          : 'INICIO DEL CAMINO';
  };

  const formatCountdown = (resetAt) => {
    const remainingMs = Date.parse(resetAt) - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return 'El siguiente punto iniciará un nuevo ciclo.';
    }
    const totalMinutes = Math.ceil(remainingMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `Reinicio en ${hours} h ${String(minutes).padStart(2, '0')} min`;
  };

  const renderPoints = (data) => {
    pointsCycle = data;
    const pointsToday = Number(data.pointsToday) || 0;
    const dailyLimit = Number(data.dailyLimit) || 11000;
    const progressPercent = Math.min(100, Math.max(0, (pointsToday / dailyLimit) * 100));
    document.getElementById('points-today').textContent = formatNumber(pointsToday);
    document.getElementById('points-percentage').textContent = `${Math.round(progressPercent)}%`;
    document.getElementById('points-progress').style.width = `${progressPercent}%`;
    document.querySelector('.progress-track').setAttribute('aria-valuemax', String(dailyLimit));
    document.querySelector('.progress-track').setAttribute(
      'aria-valuenow',
      String(Math.min(dailyLimit, Math.round(pointsToday))),
    );
    document.getElementById('gems-balance').textContent = formatNumber(data.gemsBalance, 0);
    const topPoints = document.getElementById('top-points');
    const formattedTopPoints = formatNumber(pointsToday, 0);
    if (topPoints.textContent !== formattedTopPoints) {
      topPoints.textContent = formattedTopPoints;
      topPoints.classList.remove('counter-update');
      requestAnimationFrame(() => topPoints.classList.add('counter-update'));
    }
    document.getElementById('top-gems').textContent = formatNumber(data.gemsBalance, 0);
    document.getElementById('payout-balance').textContent = formatUsd(data.payoutBalanceUsd);
    const payoutRateNote = document.getElementById('payout-rate-note');
    payoutRateNote.textContent = data.payoutRateConfigured
      ? `Conversión configurada por el servidor: ${formatUsd(data.payoutRateUsdPerPoint)} por punto DePIN verificado.`
      : 'Los retiros están deshabilitados hasta que el administrador configure una tarifa USD por punto DePIN.';
    document.getElementById('spins-remaining').textContent =
      formatNumber(data.rouletteSpinsRemaining ?? 15, 0);
    spinButton.disabled = spinInProgress ||
      (data.rouletteSpinsRemaining ?? 15) <= 0 ||
      pointsToday >= dailyLimit;
    rouletteMessage.textContent = pointsToday >= dailyLimit
      ? 'Llegaste al tope de puntos; la ruleta se habilitará con el próximo ciclo.'
      : (data.rouletteSpinsRemaining ?? 15) <= 0
        ? 'Ya usaste tus 15 giros. Volverán cuando inicie tu próximo ciclo.'
        : `Tienes ${formatNumber(data.rouletteSpinsRemaining ?? 15, 0)} giros disponibles en este ciclo de 24 horas.`;
    document.getElementById('reset-countdown').textContent = data.nextResetAt
      ? formatCountdown(data.nextResetAt)
      : 'La ventana de 24 h inicia con el primer punto.';
    const networkPointsTotal = Number(data.networkStats?.pointsTotal);
    const networkUserCount = Number(data.networkStats?.userCount);
    const networkNodeCount = Number(data.networkStats?.nodeCount);
    const hasNetworkStats = Number.isFinite(networkPointsTotal) &&
      networkPointsTotal >= 0 &&
      Number.isSafeInteger(networkUserCount) &&
      networkUserCount >= 0 &&
      Number.isSafeInteger(networkNodeCount) &&
      networkNodeCount >= 0;
    document.getElementById('network-points-total').textContent = hasNetworkStats
      ? formatNumber(networkPointsTotal)
      : 'No disponible';
    document.getElementById('network-user-count').textContent = hasNetworkStats
      ? formatNumber(networkUserCount, 0)
      : '—';
    document.getElementById('network-node-count').textContent = hasNetworkStats
      ? formatNumber(networkNodeCount, 0)
      : '—';
    document.getElementById('network-total-status').textContent = hasNetworkStats
      ? 'Total histórico sincronizado desde SQLite'
      : 'El servidor no proporcionó estadísticas globales';
    renderMilestones(data.milestones || []);
    updateScene(pointsToday, dailyLimit, data.milestones || []);
  };

  const relativeHeartbeat = (date) => {
    const elapsedSeconds = Math.max(0, (Date.now() - Date.parse(date)) / 1000);
    if (elapsedSeconds < 60) return 'hace unos segundos';
    if (elapsedSeconds < 3600) return `hace ${Math.floor(elapsedSeconds / 60)} min`;
    if (elapsedSeconds < 86400) return `hace ${Math.floor(elapsedSeconds / 3600)} h`;
    return `hace ${Math.floor(elapsedSeconds / 86400)} d`;
  };

  const renderNodes = (nodes = []) => {
    const list = document.getElementById('nodes-list');
    list.replaceChildren();
    renderAuraNodes(nodes);
    document.getElementById('node-count').textContent = formatNumber(nodes.length, 0);
    document.getElementById('nodes-panel-count').textContent = formatNumber(nodes.length, 0);
    document.getElementById('top-nodes').textContent = formatNumber(nodes.length, 0);

    if (!nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-nodes';
      empty.textContent = 'Todavía no hay nodos en tu cuenta. Registra uno para empezar a recorrer el camino.';
      list.append(empty);
      return;
    }

    nodes.forEach((node) => {
      const item = document.createElement('article');
      item.className = 'node-item';
      const copy = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'node-name-text';
      name.textContent = node.node_name;
      const meta = document.createElement('div');
      meta.className = 'node-meta';
      const points = document.createElement('span');
      points.textContent = `${formatNumber(node.points)} pts acumulados`;
      const wallet = document.createElement('span');
      wallet.textContent = node.wallet_address
        ? `Wallet ${node.wallet_address.length > 18 ? `${node.wallet_address.slice(0, 9)}…${node.wallet_address.slice(-6)}` : node.wallet_address}`
        : 'Sin wallet vinculada';
      meta.append(points, wallet);
      copy.append(name, meta);

      const status = document.createElement('span');
      const heartbeatAt = node.last_heartbeat_at ? Date.parse(node.last_heartbeat_at) : NaN;
      const online = Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= 120000;
      status.className = `node-status${online ? ' online' : ''}`;
      status.textContent = !Number.isFinite(heartbeatAt)
        ? 'Esperando heartbeat'
        : online
          ? 'Activo · ' + relativeHeartbeat(node.last_heartbeat_at)
          : 'Inactivo · ' + relativeHeartbeat(node.last_heartbeat_at);
      item.append(copy, status);
      list.append(item);
    });
  };

  const renderAuraNodes = (nodes = []) => {
    auraNodeMatrix.replaceChildren();
    document.getElementById('aura-summary').textContent =
      `${formatNumber(Math.min(nodes.length, 9), 0)} de 9 espacios ocupados`;

    for (let index = 0; index < 9; index += 1) {
      const node = nodes[index];
      const card = document.createElement('article');
      card.className = `aura-node-card${node ? ' aura-node-active' : ' aura-node-empty'}`;

      const heading = document.createElement('div');
      heading.className = 'aura-node-heading';
      const identifier = document.createElement('span');
      identifier.className = 'aura-node-id';
      identifier.textContent = `AURA ${String(index + 1).padStart(2, '0')}`;
      const state = document.createElement('span');
      state.className = 'aura-node-state';

      const name = document.createElement('h3');
      name.className = 'aura-node-name';
      name.textContent = node ? node.node_name : 'Espacio disponible';

      const emblem = document.createElement('div');
      emblem.className = 'aura-node-emblem';
      const level = document.createElement('span');
      level.className = 'aura-node-level';
      level.textContent = node && node.level !== undefined
        ? `NIVEL ${node.level}`
        : 'NIVEL —';
      emblem.append(
        svgIcon(`aura-symbol-${String(index + 1).padStart(2, '0')}`, 'aura-node-icon'),
        level,
      );

      const details = document.createElement('div');
      details.className = 'aura-node-details';
      const multiplier = document.createElement('span');
      const multiplierValue = node?.multiplier;
      const formattedMultiplier = typeof multiplierValue === 'number' || typeof multiplierValue === 'string'
        ? String(multiplierValue).startsWith('x')
          ? String(multiplierValue)
          : `x${multiplierValue}`
        : null;
      multiplier.textContent = formattedMultiplier
        ? `MULTIPLICADOR ${formattedMultiplier}`
        : 'MULTIPLICADOR NO REGISTRADO';
      details.append(multiplier);

      const points = document.createElement('p');
      points.className = 'aura-node-points';
      points.textContent = node
        ? `${formatNumber(node.points)} puntos registrados`
        : 'Sin nodo registrado';

      if (node) {
        const heartbeatAt = node.last_heartbeat_at ? Date.parse(node.last_heartbeat_at) : NaN;
        const online = Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= 120000;
        state.classList.toggle('online', online);
        state.textContent = online ? 'ACTIVO' : Number.isFinite(heartbeatAt) ? 'INACTIVO' : 'ESPERANDO';
        if (Number.isFinite(heartbeatAt)) {
          points.textContent += ` · heartbeat ${relativeHeartbeat(node.last_heartbeat_at)}`;
        }
      } else {
        state.textContent = 'DISPONIBLE';
      }

      heading.append(identifier, state);
      card.append(heading, emblem, name, details, points);
      auraNodeMatrix.append(card);
    }
  };

  const renderWithdrawals = (withdrawals = []) => {
    withdrawalList.replaceChildren();
    if (!withdrawals.length) {
      const empty = document.createElement('p');
      empty.className = 'fine-print';
      empty.textContent = 'Todavía no hay solicitudes.';
      withdrawalList.append(empty);
      return;
    }

    withdrawals.forEach((withdrawal) => {
      const item = document.createElement('article');
      item.className = 'withdrawal-item';
      const summary = document.createElement('div');
      const amount = document.createElement('strong');
      amount.textContent = `#${withdrawal.id} · ${formatUsd(withdrawal.amountUsd)}`;
      const status = document.createElement('span');
      status.textContent = withdrawal.status === 'PENDING'
        ? `Pendiente de revisión · aviso ${withdrawal.notificationStatus === 'SENT' ? 'enviado' : 'no enviado'}`
        : withdrawal.status;
      summary.append(amount, status);
      item.append(summary);

      if (withdrawal.status === 'PENDING' && withdrawal.notificationStatus === 'FAILED') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'button button-quiet';
        retry.textContent = 'Reintentar aviso';
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          setMessage(payoutMessage, 'Reintentando el aviso por correo…');
          try {
            const result = await apiRequest(`${API}/me/withdrawals/${withdrawal.id}/notify`, {
              method: 'POST',
            });
            setMessage(payoutMessage, result.message, 'success');
            await refreshDashboard(false);
          } catch (error) {
            setMessage(payoutMessage, error.message, 'error');
          } finally {
            retry.disabled = false;
          }
        });
        item.append(retry);
      }
      withdrawalList.append(item);
    });
  };

  const refreshDashboard = async (announceErrors = false) => {
    try {
      const [points, nodes, wallet, withdrawals] = await Promise.all([
        apiRequest(`${API}/me/points`),
        apiRequest(`${API}/nodes`),
        apiRequest(`${API}/me/wallet`),
        apiRequest(`${API}/me/withdrawals`),
      ]);
      renderPoints(points);
      renderNodes(nodes.nodes || []);
      if (document.activeElement !== payoutWallet) {
        payoutWallet.value = wallet.walletAddress || '';
      }
      renderWithdrawals(withdrawals.withdrawals || []);
      const hasPendingWithdrawal = (withdrawals.withdrawals || [])
        .some((withdrawal) => withdrawal.status === 'PENDING');
      withdrawButton.disabled = !points.payoutRateConfigured ||
        Number(points.payoutBalanceUsd) < 5 ||
        !wallet.walletAddress ||
        hasPendingWithdrawal;
      dashboardMessage.classList.add('hidden');
    } catch (error) {
      if (announceErrors && !sessionStorage.getItem(TOKEN_KEY)) return;
      dashboardMessage.textContent = error.message;
      dashboardMessage.classList.remove('hidden');
      if (announceErrors) dashboardMessage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const startDashboard = async (username) => {
    showDashboardView(username || 'Guaraní');
    await refreshDashboard(true);
    if (!sessionStorage.getItem(TOKEN_KEY)) return;
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(() => refreshDashboard(false), 10000);
  };

  const setAuthMode = (mode) => {
    authMode = mode;
    document.querySelectorAll('[data-auth-mode]').forEach((button) => {
      const active = button.dataset.authMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    const registering = mode === 'register';
    document.getElementById('auth-title').textContent = registering ? 'Empieza tu camino.' : 'Qué bueno verte.';
    document.getElementById('auth-subtitle').textContent = registering
      ? 'Crea tu cuenta y deja tu primera huella.'
      : 'Entra a tu espacio y sigue avanzando.';
    document.getElementById('auth-password').autocomplete = registering ? 'new-password' : 'current-password';
    document.getElementById('referrer-field').classList.toggle('hidden', !registering);
    document.getElementById('auth-referrer').required = false;
    document.getElementById('auth-submit').innerHTML = registering
      ? 'Crear mi cuenta <span aria-hidden="true">↗</span>'
      : 'Entrar al camino <span aria-hidden="true">↗</span>';
    setMessage(authMessage, '');
  };

  document.querySelectorAll('[data-auth-mode]').forEach((button) => {
    button.addEventListener('click', () => setAuthMode(button.dataset.authMode));
  });

  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = document.getElementById('auth-submit');
    submit.disabled = true;
    setMessage(authMessage, authMode === 'register' ? 'Preparando tu cuenta…' : 'Verificando tus datos…');
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const body = { username, password };
    const referredBy = document.getElementById('auth-referrer').value.trim();
    if (authMode === 'register' && referredBy) body.referredBy = referredBy;

    try {
      const result = await apiRequest(authMode === 'register' ? '/register' : '/login', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      sessionStorage.setItem(TOKEN_KEY, result.token);
      lastClaimed = new Set();
      await startDashboard(result.username || username);
      if (result.referralApplied) {
        showToast(`Cuenta creada con bono de ${formatNumber(result.newUserBonus, 0)} Gcoins.`);
      }
      authForm.reset();
    } catch (error) {
      setMessage(authMessage, error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });

  nodeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = nodeForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    setMessage(nodeMessage, 'Registrando tu nodo…');
    const nodeName = document.getElementById('node-name').value.trim();
    const walletAddress = document.getElementById('wallet-address').value.trim();
    try {
      const result = await apiRequest(`${API}/nodes`, {
        method: 'POST',
        body: JSON.stringify({
          nodeName,
          ...(walletAddress ? { walletAddress } : {}),
        }),
      });
      nodeForm.reset();
      setMessage(nodeMessage, 'Nodo registrado. Copia y guarda el token de instalación.', 'success');
      tokenValue.textContent = result.nodeToken;
      setMessage(tokenCopyMessage, '');
      tokenDialog.classList.remove('hidden');
      document.getElementById('close-token-dialog').focus();
      await refreshDashboard(false);
    } catch (error) {
      setMessage(nodeMessage, error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });

  walletForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('save-wallet-button');
    button.disabled = true;
    setMessage(payoutMessage, 'Guardando tu wallet…');
    try {
      await apiRequest(`${API}/me/wallet`, {
        method: 'PUT',
        body: JSON.stringify({ walletAddress: payoutWallet.value.trim() }),
      });
      setMessage(payoutMessage, 'Wallet guardada en tu cuenta.', 'success');
      await refreshDashboard(false);
    } catch (error) {
      setMessage(payoutMessage, error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  withdrawButton.addEventListener('click', async () => {
    withdrawButton.disabled = true;
    setMessage(payoutMessage, 'Creando una solicitud y reservando el saldo disponible…');
    try {
      const result = await apiRequest(`${API}/me/withdrawals`, { method: 'POST' });
      setMessage(payoutMessage, result.message, result.notificationSent ? 'success' : 'error');
      await refreshDashboard(false);
    } catch (error) {
      setMessage(payoutMessage, error.message, 'error');
      await refreshDashboard(false);
    }
  });

  const waitForWheel = () => new Promise((resolve) => {
    const fallback = window.setTimeout(resolve, 5100);
    rouletteWheel.addEventListener('transitionend', (event) => {
      if (event.propertyName === 'transform') {
        window.clearTimeout(fallback);
        resolve();
      }
    }, { once: true });
  });

  const animatePrize = async (points) => {
    const prizeCenters = {
      10: 63,
      30: 198,
      50: 279,
      100: 323.82,
      1000: 341.82,
    };
    const desiredAngle = (360 - prizeCenters[points] + 360) % 360;
    const currentAngle = ((wheelRotation % 360) + 360) % 360;
    const adjustment = (desiredAngle - currentAngle + 360) % 360;
    wheelRotation += 6 * 360 + adjustment;
    rouletteWheel.style.transform = `translate(-50%, -50%) rotate(${wheelRotation}deg)`;
    await waitForWheel();
  };

  spinButton.addEventListener('click', async () => {
    if (spinInProgress) return;

    spinInProgress = true;
    spinButton.disabled = true;
    rouletteResult.classList.add('hidden');
    setMessage(rouletteMessage, 'El servidor está sorteando tu premio…');

    try {
      const result = await apiRequest(`${API}/roulette/spin`, {
        method: 'POST',
        headers: { 'Idempotency-Key': createRequestId() },
      });
      await animatePrize(result.selectedPrizePoints);

      rouletteResult.replaceChildren();
      const awardedPoints = document.createElement('strong');
      awardedPoints.textContent = `+${formatNumber(result.pointsAdded)} PUNTOS`;
      const details = document.createElement('span');
      details.textContent = result.pointsAdded < result.selectedPrizePoints
        ? `Salió ${formatNumber(result.selectedPrizePoints, 0)}; se acreditaron ${formatNumber(result.pointsAdded)} para respetar el tope del ciclo.`
        : `¡Salió ${formatNumber(result.selectedPrizePoints, 0)} puntos!`;
      rouletteResult.append(awardedPoints, details);
      if (result.gemsAdded > 0) {
        const gems = document.createElement('span');
        gems.textContent = ` Hito alcanzado: +${formatNumber(result.gemsAdded, 0)} gemas.`;
        rouletteResult.append(gems);
      }
      rouletteResult.classList.remove('hidden');

      await refreshDashboard(false);
      if (result.spinsRemaining <= 0) {
        rouletteMessage.textContent = 'Usaste tus 15 giros. Volverán cuando inicie tu próximo ciclo.';
      } else if (pointsCycle && pointsCycle.pointsToday >= pointsCycle.dailyLimit) {
        rouletteMessage.textContent = 'Llegaste al tope de puntos; espera el próximo ciclo para volver a girar.';
      } else {
        rouletteMessage.textContent = `Quedan ${formatNumber(result.spinsRemaining, 0)} giros en este ciclo de 24 horas.`;
      }
    } catch (error) {
      rouletteMessage.textContent = error.message;
      rouletteMessage.classList.add('error');
      await refreshDashboard(false);
    } finally {
      rouletteMessage.classList.remove('error');
      spinInProgress = false;
      if (pointsCycle) {
        spinButton.disabled =
          pointsCycle.rouletteSpinsRemaining <= 0 ||
          pointsCycle.pointsToday >= pointsCycle.dailyLimit;
      } else {
        spinButton.disabled = true;
      }
    }
  });

  document.getElementById('copy-token-button').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(tokenValue.textContent);
      setMessage(tokenCopyMessage, 'Token copiado. Guárdalo en la configuración segura de tu nodo.', 'success');
    } catch {
      setMessage(tokenCopyMessage, 'No se pudo copiar automáticamente. Selecciona y copia el token manualmente.', 'error');
    }
  });

  const closeTokenDialog = () => {
    tokenDialog.classList.add('hidden');
    tokenValue.textContent = '';
  };
  document.getElementById('close-token-dialog').addEventListener('click', closeTokenDialog);
  document.getElementById('acknowledge-token').addEventListener('click', closeTokenDialog);
  tokenDialog.addEventListener('click', (event) => {
    if (event.target === tokenDialog) closeTokenDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !tokenDialog.classList.contains('hidden')) closeTokenDialog();
  });

  document.getElementById('refresh-button').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    await refreshDashboard(true);
    button.disabled = false;
  });
  document.getElementById('open-ad-button').addEventListener('click', () => {
    const adSlot = document.querySelector('.ad-slot');
    adSlot.scrollIntoView({ behavior: 'smooth', block: 'center' });
    adSlot.setAttribute('tabindex', '-1');
    adSlot.focus({ preventScroll: true });
  });
  document.getElementById('open-payouts-button').addEventListener('click', () => {
    if (dashboardView.classList.contains('hidden')) {
      authForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.getElementById('auth-username').focus({ preventScroll: true });
      setMessage(authMessage, 'Inicia sesión para consultar tus recompensas DePIN.');
      return;
    }
    document.getElementById('payout-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('payout-wallet').focus({ preventScroll: true });
  });
  logoutButton.addEventListener('click', () => {
    lastClaimed = new Set();
    clearSession(false);
  });

  window.setInterval(() => {
    if (pointsCycle?.nextResetAt) {
      document.getElementById('reset-countdown').textContent = formatCountdown(pointsCycle.nextResetAt);
    }
  }, 30000);

  updateEnvironmentCycle();
  window.setInterval(updateEnvironmentCycle, 60000);

  const accessToken = sessionStorage.getItem(TOKEN_KEY);
  if (accessToken) {
    const payload = accessToken.split('.')[1];
    try {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(decodeURIComponent(Array.from(atob(normalized), (char) =>
        `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
      ).join('')));
      startDashboard(claims.username || 'Guaraní');
    } catch {
      sessionStorage.removeItem(TOKEN_KEY);
      showAuthView();
    }
  } else {
    showAuthView();
  }

  const installAppButton = document.getElementById('install-app-button');
  let deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installAppButton.classList.remove('hidden');
  });

  installAppButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    const installPrompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    installAppButton.classList.add('hidden');
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } catch (error) {
      console.error('No se pudo iniciar la instalación de Gcoin.', error);
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    installAppButton.classList.add('hidden');
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js')
      .catch((error) => console.error('No se pudo registrar el service worker de Gcoin.', error));
  }
})();
