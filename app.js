// ==========================================
// SUPABASE CONFIGURATION
// ==========================================
const SUPABASE_URL = "https://jjbegipwtrpotnyfqcrv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpqYmVnaXB3dHJwb3RueWZxY3J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMTQyODAsImV4cCI6MjA5OTU5MDI4MH0.Nmf4pfmHpaxI1wp7ObHL47liheQ_MIZQoSHbdKq__wY";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==========================================
// 1. Beer Database Array (Initially Empty)
// ==========================================
let beerDatabase = [];

// ==========================================
// 2. Local State Management
// ==========================================
let userProfile = {
  name: localStorage.getItem('lcbf_name') || '',
  groupCode: localStorage.getItem('lcbf_group_code') || '',
  logs: JSON.parse(localStorage.getItem('lcbf_logs')) || [],
  activePourSize: 100
};

// App state
let currentUser = null;
let currentGroup = null;
let currentUserId = 'local-user';
let roomChannel = null;

// Holds all team records pulled from Supabase
let databaseStandings = [];

// ==========================================
// 3. App Initialization & Consolidated Flow
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // 1. Silent login / session restore first
    const { data: { session } } = await supabaseClient.auth.getSession();
    let currentSession = session;
    if (!currentSession) {
      const { data: signInData, error } = await supabaseClient.auth.signInAnonymously();
      if (error) console.error("Anonymous sign-in failed:", error);
      else currentSession = signInData.session;
    }

    if (currentSession && currentSession.user) {
      currentUserId = currentSession.user.id;
    }

    // 2. Handle user profile (prompts user if not configured)
    checkUserProfile();
    
    // 3. Enter the realtime room matching user state
    enterRoom(userProfile.name, userProfile.groupCode);

    // 4. Restore history directly from Supabase if local storage is cleared
    await fetchMyHistory();

    // 5. Update UI states
    updateDashboard();

    // 6. Kick off async beer parsing
    await loadBeers();

    // 7. Register background sync intervals
    setInterval(syncPendingLogs, 10000);
    window.addEventListener('online', syncPendingLogs);
    
  } catch (err) {
    console.error("Initialization crash prevented: ", err);
  }
});

function enterRoom(username, groupCode) {
  currentUser = username;
  currentGroup = groupCode;

  // Fetch group data to display standings instantly
  fetchLiveStandings();
  renderHistory();

  // Clean up any stale subscription channels before setting up a new one
  if (roomChannel) {
    supabaseClient.removeChannel(roomChannel);
  }

  // Use one unified room channel for both PostgreSQL mutations and Broadcast events
  roomChannel = supabaseClient.channel(`group:${currentGroup}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'drinks_logged', filter: `group_code=eq.${currentGroup}` },
      () => {
        console.log('Standings altered in DB, updating live...');
        fetchLiveStandings();
      }
    )
    .on(
      'broadcast',
      { event: 'history_cleared' },
      () => {
        console.log('Another user cleared their logs');
        fetchLiveStandings(); 
      }
    )
    .on(
      'broadcast',
      { event: 'drink_removed' },
      () => {
        console.log('Another device removed a drink');
        fetchLiveStandings();
      }
    )
    .subscribe();
}

function checkUserProfile() {
  if (!userProfile.name) {
    const promptName = prompt("Enter your Name (for the leaderboard):", "Beer Fan");
    userProfile.name = (promptName && promptName.trim()) ? promptName.trim() : "Beer Fan";
    localStorage.setItem('lcbf_name', userProfile.name);
  }
  
  if (!userProfile.groupCode) {
    const promptCode = prompt("Enter a shared Group Code to join friends:", "LCBF26");
    userProfile.groupCode = (promptCode && promptCode.trim()) ? promptCode.trim().toUpperCase() : "LCBF26";
    localStorage.setItem('lcbf_group_code', userProfile.groupCode);
  }
  
  document.getElementById('profileName').firstElementChild.innerText = `${userProfile.name} (${userProfile.groupCode})`;
}

// ==========================================
// 4. Loader & Auto-Parser
// ==========================================
async function loadBeers() {
  const beerListContainer = document.getElementById('beerList');
  beerListContainer.innerHTML = `
    <div class="text-center py-12 text-slate-400 space-y-3">
      <div class="animate-spin text-3xl inline-block">⏳</div>
      <p class="text-sm font-semibold">Parsing beers.json...</p>
    </div>
  `;

  try {
    const response = await fetch('beers.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const rawPayload = await response.json();
    beerDatabase = parseBeerData(rawPayload);
    filterBeers();
    
  } catch (error) {
    console.error("Failed to load beers.json:", error);
    beerListContainer.innerHTML = `
      <div class="text-center py-12 text-red-400 border border-red-900/30 bg-red-950/10 rounded-xl p-4">
        <p class="text-sm font-bold">⚠️ Failed to load beer list</p>
        <p class="text-xs text-slate-500 mt-1">Check that beers.json is in your project directory.</p>
      </div>
    `;
  }
}

function parseBeerData(payload) {
  try {
    let rawBeerObject = {};

    if (payload && payload.beer_data) {
      rawBeerObject = typeof payload.beer_data === 'string' ? JSON.parse(payload.beer_data) : payload.beer_data;
    } else {
      rawBeerObject = payload;
    }

    const beerArray = Object.values(rawBeerObject).filter(beer => {
      return beer.fri_pm && String(beer.fri_pm).trim().toLowerCase() === 'yes';
    });

    return beerArray.map(beer => ({
      wab_beer_id: beer.wab_beer_id || beer.ut_bid,
      beer_name: cleanText(beer.beer_name || "Unknown Beer"),
      brewer_name: cleanText(beer.brewer_name || "Unknown Brewery"),
      abv: beer.abv ? parseFloat(beer.abv).toFixed(1) : "0.0",
      untappd_style: cleanText(beer.untappd_style || "Other"),
      description: cleanText(beer.description || "No description provided.", true)
    }));
  } catch (e) {
    console.error("Parse Error: ", e);
    return [];
  }
}

function cleanText(text, stripHTML = false) {
  if (!text) return '';
  
  let cleaned = text
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&deg;/g, '°');
    
  if (stripHTML) {
    cleaned = cleaned
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '');
  }
  
  return cleaned.trim();
}

// ==========================================
// 5. Offline-Ready Logging and Cloud Sync
// ==========================================
function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function logBeer(id) {
  const beer = beerDatabase.find(b => String(b.wab_beer_id) === String(id));
  if (!beer) return;

  const unitsCalculated = (parseFloat(beer.abv) * userProfile.activePourSize) / 1000;
  
  const newEntry = {
    id: generateUUID(), 
    beer_id: id,
    name: beer.beer_name,
    brewer: beer.brewer_name,
    abv: beer.abv,
    size: userProfile.activePourSize,
    units: unitsCalculated,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    created_at: new Date().toISOString(),
    synced: false
  };

  userProfile.logs.push(newEntry);
  localStorage.setItem('lcbf_logs', JSON.stringify(userProfile.logs));
  
  updateDashboard();
  triggerButtonFeedback();
  syncPendingLogs();
  filterBeers();
}

async function syncPendingLogs() {
  const pending = userProfile.logs.filter(log => !log.synced);
  if (pending.length === 0 || !navigator.onLine) return;

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return;

  for (let log of pending) {
    try {
      const { error } = await supabaseClient
        .from('drinks_logged')
        .insert([{
          id: log.id,
          user_id: user.id,
          user_name: userProfile.name,
          group_code: userProfile.groupCode,
          beer_id: log.beer_id,
          beer_name: log.name,
          brewer_name: log.brewer,
          abv: parseFloat(log.abv),
          volume_ml: log.size,
          units: log.units,
          created_at: log.created_at || new Date().toISOString()
        }]);

      if (!error) {
        log.synced = true;
      }
    } catch (err) {
      console.warn("Sync temporarily failed: ", err);
    }
  }

  localStorage.setItem('lcbf_logs', JSON.stringify(userProfile.logs));
  updateDashboard();
}

async function fetchLiveStandings() {
  try {
    const { data, error } = await supabaseClient
      .from('drinks_logged')
      .select('user_id, user_name, units, beer_id, created_at')
      .eq('group_code', userProfile.groupCode);

    if (error) throw error;
    databaseStandings = data || [];
    renderLeaderboard();
  } catch (err) {
    console.warn("Could not fetch server standings (Offline?):", err);
  }
}

// ==========================================
// 6. UI Updates and Render Engine
// ==========================================
function updateDashboard() {
  const totalUnits = userProfile.logs.reduce((sum, log) => sum + log.units, 0);
  document.getElementById('totalUnitsText').innerText = totalUnits.toFixed(2);
  document.getElementById('logCount').innerText = userProfile.logs.length;

  const display = document.getElementById('unitDisplay');
  display.className = "px-4 py-2 rounded-xl text-center min-w-24 border transition-all duration-300 cursor-pointer hover:scale-105 active:scale-95 shadow-sm hover:shadow-md ";
  
  if (totalUnits < 4) {
    display.classList.add('bg-emerald-500/10', 'border-emerald-500/30', 'text-emerald-400', 'hover:border-emerald-500/50');
  } else if (totalUnits < 8) {
    display.classList.add('bg-amber-500/10', 'border-amber-500/30', 'text-amber-400', 'hover:border-amber-500/50');
  } else {
    display.classList.add('bg-rose-500/10', 'border-rose-500/30', 'text-rose-400', 'hover:border-rose-500/50');
  }

  display.onclick = () => openUnitsDetail();

  renderLeaderboard();
  renderHistory();
}

function openUnitsDetail() {
  const logs = userProfile.logs;
  
  const totalVolumeMl = logs.reduce((sum, log) => sum + log.size, 0);
  const displayVolume = totalVolumeMl >= 1000 
    ? `${(totalVolumeMl / 1000).toFixed(2)} L` 
    : `${totalVolumeMl} ml`;
  document.getElementById('statTotalVolume').innerText = displayVolume;

  let weightedABV = 0;
  if (totalVolumeMl > 0) {
    const totalWeightedAbvSum = logs.reduce((sum, log) => sum + (parseFloat(log.abv) * log.size), 0);
    weightedABV = totalWeightedAbvSum / totalVolumeMl;
  }
  document.getElementById('statWeightedABV').innerText = `${weightedABV.toFixed(1)}%`;

  let heaviestHitter = "None yet";
  if (logs.length > 0) {
    const heaviest = [...logs].sort((a, b) => parseFloat(b.abv) - parseFloat(a.abv))[0];
    heaviestHitter = `${heaviest.name} (${heaviest.abv}%)`;
  }
  document.getElementById('statHeaviestHitter').innerText = heaviestHitter;

  calculateBAC();
  document.getElementById('unitsDetailModal').classList.remove('hidden');
}

function closeUnitsDetail() {
  document.getElementById('unitsDetailModal').classList.add('hidden');
}

function calculateBAC() {
  const logs = userProfile.logs;
  const totalUnits = logs.reduce((sum, log) => sum + log.units, 0);
  
  const bacPercentageEl = document.getElementById('bacPercentage');
  const statusBadge = document.getElementById('bacStatusBadge');
  const warningText = document.getElementById('bacWarningText');
  const soberCountdownEl = document.getElementById('statSoberCountdown');
  const sessionBadge = document.getElementById('sessionDurationBadge');

  if (totalUnits === 0) {
    bacPercentageEl.innerText = "0.000%";
    statusBadge.className = "inline-block text-[10px] font-black uppercase px-2.5 py-1 rounded-md mb-1 bg-slate-800 text-slate-400";
    statusBadge.innerText = "Sober";
    warningText.innerText = "No recorded logs to calculate profile.";
    soberCountdownEl.innerText = "Sober Now";
    soberCountdownEl.className = "text-lg font-black text-emerald-400 mt-0.5 block";
    sessionBadge.innerText = "No active session";
    evaluateAchievements(0);
    return;
  }

  const sex = document.getElementById('bacGender').value;
  let weight = parseFloat(document.getElementById('bacWeight').value);
  if (!weight || isNaN(weight) || weight <= 0) {
    weight = 65; 
  }

  const weightUnit = document.getElementById('bacWeightUnit').value;
  if (weightUnit === 'lbs') {
    weight = weight * 0.453592;
  }

  const bodyWeightGrams = weight * 1000;
  const r = (sex === 'female') ? 0.55 : 0.68;

  const sortedLogs = [...logs]
    .map(log => ({
      ...log,
      created_at: log.created_at || new Date().toISOString()
    }))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const now = new Date();
  const firstDrinkTime = new Date(sortedLogs[0].created_at);
  
  const activeSessionMs = now - firstDrinkTime;
  const sessionHours = Math.floor(activeSessionMs / 3600000);
  const sessionMins = Math.round((activeSessionMs % 3600000) / 60000);
  sessionBadge.innerText = `Session Active: ${sessionHours}h ${sessionMins}m`;

  let currentBAC = 0;
  let lastTime = firstDrinkTime;

  sortedLogs.forEach(log => {
    const logTime = new Date(log.created_at);
    const elapsedHours = Math.max(0, (logTime - lastTime) / 3600000);
    currentBAC = Math.max(0, currentBAC - (0.015 * elapsedHours));

    const drinkGrams = log.units * 8; 
    const drinkPeakBAC = (drinkGrams / (bodyWeightGrams * r)) * 100;
    currentBAC += drinkPeakBAC;

    lastTime = logTime;
  });

  const trailingHours = Math.max(0, (now - lastTime) / 3600000);
  currentBAC = Math.max(0, currentBAC - (0.015 * trailingHours));

  bacPercentageEl.innerText = `${currentBAC.toFixed(3)}%`;

  const hoursToSober = currentBAC / 0.015;

  if (currentBAC > 0) {
    const soberDate = new Date(now.getTime() + (hoursToSober * 3600000));
    const soberTimeString = soberDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const hrs = Math.floor(hoursToSober);
    const mins = Math.round((hoursToSober - hrs) * 60);
    
    let countdownDisplay = `${soberTimeString}`;
    if (hrs > 0 || mins > 0) {
      countdownDisplay += ` (in ${hrs > 0 ? hrs + 'h ' : ''}${mins}m)`;
    }
    
    soberCountdownEl.innerText = countdownDisplay;
    soberCountdownEl.className = "text-lg font-black text-amber-400 mt-0.5 block";
  } else {
    soberCountdownEl.innerText = "Sober Now";
    soberCountdownEl.className = "text-lg font-black text-emerald-400 mt-0.5 block";
  }

  if (currentBAC === 0) {
    statusBadge.className = "inline-block text-[10px] font-black uppercase px-2.5 py-1 rounded-md mb-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30";
    statusBadge.innerText = "Sober / Clear";
    warningText.innerText = "All logged alcohol has been metabolized.";
  } else if (currentBAC < 0.05) {
    statusBadge.className = "inline-block text-[10px] font-black uppercase px-2.5 py-1 rounded-md mb-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30";
    statusBadge.innerText = "Light Buzz";
    warningText.innerText = "Feeling warm, slight relaxation. Safe and Big Chillin'.";
  } else if (currentBAC < 0.08) {
    statusBadge.className = "inline-block text-[10px] font-black uppercase px-2.5 py-1 rounded-md mb-1 bg-amber-500/10 text-amber-400 border border-amber-500/30";
    statusBadge.innerText = "Moderate Buzz";
    warningText.innerText = "Approaching UK legal limit. Coordination slightly dulled.";
  } else if (currentBAC < 0.18) {
    statusBadge.className = "inline-block text-[10px] font-black uppercase px-2.5 py-1 rounded-md mb-1 bg-rose-500/10 text-rose-400 border border-rose-500/30";
    statusBadge.innerText = "Impaired";
    warningText.innerText = "Definite impairment, over UK limit. Grab some water before the next round!";
  } else {
    statusBadge.className = "inline-block text-[10px] font-black uppercase px-2.5 py-1 rounded-md mb-1 bg-red-600 text-white animate-pulse";
    statusBadge.innerText = "Over-served";
    warningText.innerText = "High intoxication. Stop logging; locate water and sit down.";
  }

  evaluateAchievements(currentBAC);
}

function renderLeaderboard() {
  const leaderboardContainer = document.getElementById('leaderboardList');
  if (!leaderboardContainer) return;

  const aggregates = {};
  const myName = userProfile.name ? userProfile.name.trim() : "Me";
  const myId = currentUserId;

  const myLocalLogs = Array.isArray(userProfile.logs) ? userProfile.logs : [];
  const myTotalUnits = myLocalLogs.reduce((sum, log) => sum + parseFloat(log.units || 0), 0);
  
  aggregates[myId] = {
    name: myName,
    units: myTotalUnits,
    isMe: true
  };

  if (Array.isArray(databaseStandings)) {
    databaseStandings.forEach(row => {
      if (!row) return;
      
      const userId = row.user_id || row.user_name || 'unknown';
      const userName = row.user_name ? row.user_name.trim() : 'Beer Fan';
      const units = parseFloat(row.units || 0);

      if (isNaN(units)) return;
      if (userId === myId) return;

      if (aggregates[userId]) {
        aggregates[userId].units += units;
      } else {
        aggregates[userId] = {
          name: userName,
          units: units,
          isMe: false
        };
      }
    });
  }

  const sortedLeaderboard = Object.values(aggregates)
    .filter(user => user.units > 0) 
    .sort((a, b) => b.units - a.units);

  leaderboardContainer.innerHTML = '';
  
  if (sortedLeaderboard.length === 0) {
    leaderboardContainer.innerHTML = '<div class="text-center py-6 text-sm text-slate-500">Add a drink to kick off the leaderboard!</div>';
    return;
  }

  sortedLeaderboard.forEach((user, index) => {
    const rowEl = document.createElement('div');
    rowEl.className = `flex items-center justify-between p-3 rounded-xl border ${
      user.isMe 
        ? 'bg-festival/10 border-festival/30 text-festival font-bold' 
        : 'bg-slate-950 border-slate-850 text-slate-200'
    }`;
    
    const safeName = user.name.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));

    rowEl.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="text-xs font-black opacity-60">#${index + 1}</span>
        <span class="text-sm">${safeName} ${user.isMe ? '<span>(You)</span>' : ''}</span>
      </div>
      <span class="text-sm font-black">${user.units.toFixed(2)} u</span>
    `;
    leaderboardContainer.appendChild(rowEl);
  });
}

async function fetchMyHistory() {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;

    const { data, error } = await supabaseClient
      .from('drinks_logged')
      .select('*')
      .eq('user_id', user.id);

    if (error) throw error;
    
    if (data && data.length > 0) {
      const dbLogs = data.map(row => ({
        id: row.id,
        beer_id: row.beer_id,
        name: row.beer_name,
        brewer: row.brewer_name,
        abv: row.abv.toString(),
        size: row.volume_ml,
        units: row.units,
        timestamp: row.created_at ? new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        created_at: row.created_at,
        synced: true
      }));

      const localIds = new Set(userProfile.logs.map(log => log.id));
      const mergedLogs = [...userProfile.logs];
      dbLogs.forEach(dbLog => {
        if (!localIds.has(dbLog.id)) {
          mergedLogs.push(dbLog);
        }
      });

      userProfile.logs = mergedLogs;
      localStorage.setItem('lcbf_logs', JSON.stringify(userProfile.logs));
    }
  } catch (err) {
    console.warn("Could not sync history from cloud:", err);
  }
}

function renderHistory() {
  const list = document.getElementById('historyList');
  if (userProfile.logs.length === 0) {
    list.innerHTML = `<p class="text-center text-sm text-slate-500 py-6">Your logged pours show up here!</p>`;
    return;
  }

  list.innerHTML = userProfile.logs.map((log) => {
    return `
      <div class="flex items-center justify-between bg-slate-950 border border-slate-850 p-3 rounded-xl">
        <div>
          <div class="flex items-center gap-2">
            <h5 class="text-xs font-bold text-slate-200">${log.name}</h5>
            ${log.synced 
              ? '<span class="text-[9px] text-emerald-500 bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-900/40">Synced</span>' 
              : '<span class="text-[9px] text-amber-500 bg-amber-950/40 px-1.5 py-0.5 rounded border border-amber-900/40 animate-pulse">Pending</span>'
            }
          </div>
          <p class="text-[10px] text-slate-400 mt-0.5">${log.brewer} • ${log.size}ml @ ${log.timestamp}</p>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs font-extrabold text-festival">${log.units.toFixed(2)} u</span>
          <button onclick="removeLog('${log.id}')" class="text-slate-500 hover:text-red-400 text-lg font-bold px-1">&times;</button>
        </div>
      </div>
    `;
  }).reverse().join('');
}

// ==========================================
// 8. General UI Utilities
// ==========================================
function setPourSize(size, element) {
  userProfile.activePourSize = size;
  document.querySelectorAll('.pour-btn').forEach(btn => {
    btn.classList.remove('bg-festival', 'text-slate-950');
    btn.classList.add('text-slate-400', 'hover:text-slate-200');
  });
  element.classList.remove('text-slate-400', 'hover:text-slate-200');
  element.classList.add('bg-festival', 'text-slate-950');
}

async function editName() {
  const newName = prompt("Enter your Name (for the leaderboard):", userProfile.name);
  if (newName === null) return;
  
  const newGroup = prompt("Enter a shared Group Code to join friends:", userProfile.groupCode);
  if (newGroup === null) return;

  const finalName = newName.trim() ? newName.trim() : "Beer Fan";
  const finalGroup = newGroup.trim() ? newGroup.trim().toUpperCase() : "LCBF26";

  const nameChanged = finalName !== userProfile.name;
  const groupChanged = finalGroup !== userProfile.groupCode;

  userProfile.name = finalName;
  userProfile.groupCode = finalGroup;
  
  localStorage.setItem('lcbf_name', userProfile.name);
  localStorage.setItem('lcbf_group_code', userProfile.groupCode);
  
  document.getElementById('profileName').firstElementChild.innerText = `${userProfile.name} (${userProfile.groupCode})`;
  
  if (nameChanged) {
    await updateNameInDatabase(finalName);
  }
  
  if (groupChanged) {
    enterRoom(userProfile.name, userProfile.groupCode);
  }

  updateDashboard();
  syncPendingLogs();
}

async function updateNameInDatabase(newName) {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;

    await supabaseClient
      .from('drinks_logged')
      .update({ user_name: newName })
      .eq('user_id', user.id);
  } catch (err) {
    console.warn("Could not sync new name profile to Supabase:", err);
  }
}

function renderBeerList(beers) {
  const listContainer = document.getElementById('beerList');
  document.getElementById('beerCount').innerText = beers.length;
  
  if (beers.length === 0) {
    listContainer.innerHTML = `
      <div class="text-center py-8 text-slate-500 text-sm">
        No matching beers found. Try searching something else!
      </div>
    `;
    return;
  }

  listContainer.innerHTML = beers.map(beer => {
    return `
      <div 
        onclick="openBeerDetail('${beer.wab_beer_id}')"
        class="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-3 shadow-md hover:border-slate-700 transition-all cursor-pointer transform hover:-translate-y-0.5 duration-200"
      >
        <div class="space-y-1">
          <div class="flex items-start justify-between">
            <h4 class="font-bold text-slate-100 text-base leading-tight">${beer.beer_name}</h4>
            <span class="bg-slate-800 text-slate-300 text-xs font-bold px-2 py-0.5 rounded-md shrink-0 ml-2">
              ${beer.abv}%
            </span>
          </div>
          <p class="text-xs font-semibold text-festival uppercase tracking-wider">${beer.brewer_name}</p>
          <p class="text-slate-400 text-xs line-clamp-2 mt-1 leading-normal">${beer.description}</p>
        </div>
        <div class="flex items-center justify-between border-t border-slate-800/80 pt-3">
          <span class="text-[10px] uppercase font-bold text-slate-500 tracking-wide">
            Style: <span class="text-slate-400 font-medium normal-case">${beer.untappd_style}</span>
          </span>
          <button 
            onclick="event.stopPropagation(); logBeer('${beer.wab_beer_id}')" 
            class="bg-festival text-slate-950 text-xs font-extrabold px-4 py-2 rounded-lg active:scale-95 transition-transform"
          >
            + Log Pour
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function openBeerDetail(beerId) {
  const beer = beerDatabase.find(b => String(b.wab_beer_id) === String(beerId));
  if (!beer) return;

  document.getElementById('modalBeerStyle').innerText = beer.untappd_style.toUpperCase();
  document.getElementById('modalBeerName').innerText = beer.beer_name;
  document.getElementById('modalBeerBrewer').innerText = beer.brewer_name;
  document.getElementById('modalBeerABV').innerText = `${beer.abv}%`;
  
  const calculatedUnits = (parseFloat(beer.abv) * userProfile.activePourSize) / 1000;
  document.getElementById('modalBeerUnits').innerText = `${calculatedUnits.toFixed(2)} u`;
  document.getElementById('modalActivePourText').innerText = `${userProfile.activePourSize}ml Pour`;
  document.getElementById('modalBeerDescription').innerText = beer.description;

  const activityContainer = document.getElementById('modalBeerActivity');
  const normalizedMyName = userProfile.name.trim().toLowerCase();
  
  const groupLogsForBeer = databaseStandings.filter(row => String(row.beer_id) === String(beerId));
  const iHaveTriedIt = userProfile.logs.some(log => String(log.beer_id) === String(beerId));
  
  const othersWhoDrank = [...new Set(
    groupLogsForBeer
      .map(row => row.user_name.trim())
      .filter(name => name.toLowerCase() !== normalizedMyName)
  )];

  let activityHTML = '';
  if (iHaveTriedIt && othersWhoDrank.length > 0) {
    activityHTML = `
      <div class="text-xl">🍻</div>
      <div>
        <p class="font-bold text-slate-200 text-xs sm:text-sm">You and ${othersWhoDrank.join(', ')} have tried this!</p>
        <p class="text-[10px] text-slate-500 mt-0.5">Checked in ${groupLogsForBeer.length} times total by your group.</p>
      </div>
    `;
  } else if (iHaveTriedIt) {
    activityHTML = `
      <div class="text-xl">✅</div>
      <div>
        <p class="font-bold text-slate-200 text-xs sm:text-sm">You've logged this beer!</p>
        <p class="text-[10px] text-slate-500 mt-0.5">Nobody else in your group has checked this one in yet.</p>
      </div>
    `;
  } else if (othersWhoDrank.length > 0) {
    activityHTML = `
      <div class="text-xl">👀</div>
      <div>
        <p class="font-bold text-slate-200 text-xs sm:text-sm">${othersWhoDrank.join(', ')} tried this!</p>
        <p class="text-[10px] text-slate-500 mt-0.5">They've already checked it in. Snag a pour and catch up!</p>
      </div>
    `;
  } else {
    activityHTML = `
      <div class="text-xl">🌟</div>
      <div>
        <p class="font-bold text-slate-300 text-xs sm:text-sm">Uncharted territory!</p>
        <p class="text-[10px] text-slate-500 mt-0.5">Be the absolute first in your group to log this beer.</p>
      </div>
    `;
  }
  activityContainer.innerHTML = activityHTML;

  const logButton = document.getElementById('modalLogButton');
  logButton.onclick = () => {
    logBeer(beer.wab_beer_id);
    closeBeerDetail();
  };

  document.getElementById('beerDetailModal').classList.remove('hidden');
}

function closeBeerDetail() {
  document.getElementById('beerDetailModal').classList.add('hidden');
}

function filterBeers() {
  const searchQuery = document.getElementById('searchBar').value.toLowerCase().trim();
  const activeStyleFilter = document.getElementById('filterStyle').value;
  const activeStatusFilter = document.getElementById('filterStatus').value;
  const sortOption = document.getElementById('sortOption').value;

  let filtered = [...beerDatabase];

  if (searchQuery) {
    filtered = filtered.filter(beer => 
      beer.beer_name.toLowerCase().includes(searchQuery) || 
      beer.brewer_name.toLowerCase().includes(searchQuery)
    );
  }

  if (activeStyleFilter !== 'all') {
    filtered = filtered.filter(beer => {
      const styleText = (beer.untappd_style || '').toLowerCase();
      switch (activeStyleFilter) {
        case 'hoppy':
          return styleText.includes('ipa') || styleText.includes('pale') || styleText.includes('hop') || styleText.includes('bitter');
        case 'dark':
          return styleText.includes('stout') || styleText.includes('porter') || styleText.includes('dark') || styleText.includes('black') || styleText.includes('mild') || styleText.includes('brown');
        case 'sour':
          return styleText.includes('sour') || styleText.includes('wild') || styleText.includes('gose') || styleText.includes('lambic') || styleText.includes('saison') || styleText.includes('farmhouse') || styleText.includes('flanders');
        case 'crisp':
          return styleText.includes('lager') || styleText.includes('pilsner') || styleText.includes('helles') || styleText.includes('blonde') || styleText.includes('kolsch') || styleText.includes('golden') || styleText.includes('light');
        default:
          return true;
      }
    });
  }

  if (activeStatusFilter !== 'all') {
    const loggedIds = new Set(userProfile.logs.map(log => String(log.beer_id)));
    if (activeStatusFilter === 'logged') {
      filtered = filtered.filter(beer => loggedIds.has(String(beer.wab_beer_id)));
    } else if (activeStatusFilter === 'untried') {
      filtered = filtered.filter(beer => !loggedIds.has(String(beer.wab_beer_id)));
    }
  }

  if (sortOption === 'abv_desc') {
    filtered.sort((a, b) => parseFloat(b.abv) - parseFloat(a.abv));
  } else if (sortOption === 'abv_asc') {
    filtered.sort((a, b) => parseFloat(a.abv) - parseFloat(b.abv));
  } else if (sortOption === 'name_asc') {
    filtered.sort((a, b) => a.beer_name.localeCompare(b.beer_name));
  } else if (sortOption === 'brewer_asc') {
    filtered.sort((a, b) => a.brewer_name.localeCompare(b.brewer_name));
  }

  renderBeerList(filtered);
}

async function removeLog(logId) {
  if (!userProfile || !Array.isArray(userProfile.logs)) return;

  const backupLogs = [...userProfile.logs];
  
  userProfile.logs = userProfile.logs.filter(log => log.id !== logId);
  localStorage.setItem('lcbf_logs', JSON.stringify(userProfile.logs));
  updateDashboard();  
  calculateBAC(); 

  try {
    const { error } = await supabaseClient
      .from('drinks_logged')
      .delete()
      .eq('id', logId);

    if (error) throw error;
  } catch (error) {
    console.error("Network sync failed. Rolling back local deletion:", error);
    userProfile.logs = backupLogs;
    localStorage.setItem('lcbf_logs', JSON.stringify(userProfile.logs));
    updateDashboard();
    calculateBAC();
  }
}

async function clearAllLogs() {
  const confirmClear = confirm("Are you sure you want to clear your entire drink history from the database? This cannot be undone.");
  if (!confirmClear) return;

  try {
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      throw new Error("Could not retrieve your active user session. Try refreshing the page.");
    }

    const { data, error } = await supabaseClient
      .from('drinks_logged')
      .delete()
      .eq('user_id', user.id)
      .select();

    if (error) throw error;

    userProfile.logs = [];
    localStorage.setItem('lcbf_logs', JSON.stringify([]));
    updateDashboard();
    filterBeers();

    await fetchLiveStandings();

    const activeChannel = roomChannel || supabaseClient.channel(`group:${userProfile.groupCode}`);
    if (activeChannel) {
      await activeChannel.send({
        type: 'broadcast',
        event: 'history_cleared',
        payload: { id: user.id }
      });
    }

    alert("Your entire drink history has been cleared from the database.");

  } catch (err) {
    console.error("Failed to clear cloud logs:", err);
    alert(`Error clearing history: ${err.message || err}`);
  }
}

function toggleLeaderboard(show) {
  document.getElementById('leaderboardModal').classList.toggle('hidden', !show);
}

function toggleHistoryModal(show) {
  document.getElementById('historyModal').classList.toggle('hidden', !show);
}

function triggerButtonFeedback() {
  const text = document.getElementById('totalUnitsText');
  text.classList.add('scale-125', 'text-white');
  setTimeout(() => {
    text.classList.remove('scale-125', 'text-white');
  }, 150);
}

// ==========================================
// FESTIVAL ACHIEVEMENTS & TROPHIES ENGINE
// ==========================================
function evaluateAchievements(currentBAC) {
  const logs = userProfile.logs;
  const groupLogs = databaseStandings;
  const normalizedMyName = userProfile.name.trim().toLowerCase();

  const getStyleCategory = (styleStr) => {
    const style = (styleStr || '').toLowerCase();
    if (style.includes('ipa') || style.includes('pale') || style.includes('hop') || style.includes('bitter')) return 'hoppy';
    if (style.includes('stout') || style.includes('porter') || style.includes('dark') || style.includes('black') || style.includes('mild') || style.includes('brown')) return 'dark';
    if (style.includes('sour') || style.includes('wild') || style.includes('gose') || style.includes('lambic') || style.includes('saison') || style.includes('farmhouse') || style.includes('flanders')) return 'sour';
    if (style.includes('lager') || style.includes('pilsner') || style.includes('helles') || style.includes('blonde') || style.includes('kolsch') || style.includes('golden') || style.includes('light')) return 'crisp';
    return 'other';
  };

  const uniqueStylesLogged = new Set(logs.map(log => {
    const matchedBeer = beerDatabase.find(b => String(b.wab_beer_id) === String(log.beer_id));
    return getStyleCategory(matchedBeer ? matchedBeer.untappd_style : '');
  }));
  uniqueStylesLogged.delete('other'); 

  let hasFirstBlood = false;
  if (logs.length > 0 && groupLogs.length > 0) {
    hasFirstBlood = logs.some(myLog => {
      const myLogTime = new Date(myLog.created_at);
      const otherGroupEntries = groupLogs.filter(row => 
        String(row.beer_id) === String(myLog.beer_id) && 
        row.user_name.trim().toLowerCase() !== normalizedMyName
      );

      if (otherGroupEntries.length === 0) return true;
      return otherGroupEntries.every(otherLog => new Date(otherLog.created_at) > myLogTime);
    });
  }

  const achievements = [
    {
      id: 'first_blood',
      title: 'First Blood 🩸',
      desc: 'Be the first in your group to log a specific tap.',
      unlocked: hasFirstBlood
    },
    {
      id: 'space_cadet',
      title: 'Space Cadet 🚀',
      desc: 'Log any heavy hitter with an ABV of 9.0% or higher.',
      unlocked: logs.some(log => parseFloat(log.abv) >= 9.0)
    },
    {
      id: 'pint_explorer',
      title: 'Pint Explorer 🗺️',
      desc: 'Log beers from 3 distinct style buckets (Hoppy, Dark, Sour, Crisp).',
      unlocked: uniqueStylesLogged.size >= 3
    },
    {
      id: 'pace_car',
      title: 'Pace Car 🏎️',
      desc: 'Log 3+ pours while keeping your estimated BAC below 0.05%.',
      unlocked: logs.length >= 3 && currentBAC > 0 && currentBAC < 0.05
    },
    {
      id: 'heavy_lifter',
      title: 'Heavy Lifter 🏋️‍♂️',
      desc: 'Consume a total of 1.0 Liter (1000ml) or more of beer.',
      unlocked: logs.reduce((sum, log) => sum + log.size, 0) >= 1000
    },
    {
      id: 'frequent_flyer',
      title: 'Frequent Flyer ✈️',
      desc: 'Log 5 or more pours over the course of the evening.',
      unlocked: logs.length >= 5
    }
  ];

  renderAchievements(achievements);
}

function renderAchievements(achievements) {
  const grid = document.getElementById('achievementsGrid');
  if (!grid) return;
  const unlockedCount = achievements.filter(a => a.unlocked).length;
  
  document.getElementById('trophyCountBadge').innerText = `${unlockedCount} / ${achievements.length} Unlocked`;

  grid.innerHTML = achievements.map(ach => {
    if (ach.unlocked) {
      return `
        <div class="bg-slate-950 border border-festival/30 p-3 rounded-xl flex flex-col justify-center relative overflow-hidden group hover:border-festival/60 transition-all">
          <div class="absolute -right-3 -bottom-3 text-3xl opacity-10 pointer-events-none group-hover:scale-110 transition-transform">⭐</div>
          <h5 class="text-xs font-black text-festival leading-tight">${ach.title}</h5>
          <p class="text-[10px] text-slate-300 mt-1 leading-snug">${ach.desc}</p>
        </div>
      `;
    } else {
      return `
        <div class="bg-slate-950/40 border border-slate-900/60 p-3 rounded-xl flex flex-col justify-center opacity-40 select-none">
          <h5 class="text-xs font-bold text-slate-500 leading-tight">${ach.title} Locked 🔒</h5>
          <p class="text-[10px] text-slate-600 mt-1 leading-snug">${ach.desc}</p>
        </div>
      `;
    }
  }).join('');
}