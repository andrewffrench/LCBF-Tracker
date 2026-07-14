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

// DOM Elements
const usernameInput = document.getElementById('username-input');
const groupInput = document.getElementById('group-input');

// App state
let currentUser = null;
let currentGroup = null;
let roomChannel = null;

// Holds all team records pulled from Supabase
let databaseStandings = [];

// ==========================================
// 3. App Initialization (Robust Error Boundary)
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // 1. Handle user profile without infinite loops
    checkUserProfile();
    
    // 2. Refresh basic counters from local storage
    updateDashboard();

    // 3. Kick off async operations
    await loadBeers();
    await fetchLiveStandings();
    setupRealtimeSync();

    // 4. Register background sync intervals
    setInterval(syncPendingLogs, 10000);
    window.addEventListener('online', syncPendingLogs);
    
  } catch (err) {
    console.error("Initialization crash prevented: ", err);
  }
});

// Silent login and session restore on load
window.addEventListener('DOMContentLoaded', async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();
  
  if (!session) {
    const { error } = await supabaseClient.auth.signInAnonymously();
    if (error) console.error("Anonymous sign-in failed:", error);
  }

  // FIX: Match the storage keys used in checkUserProfile()
  const savedUser = localStorage.getItem('lcbf_name');
  const savedGroup = localStorage.getItem('lcbf_group_code');

  if (savedUser && savedGroup) {
    enterRoom(savedUser, savedGroup);
  }
});

function enterRoom(username, groupCode) {
  currentUser = username;
  currentGroup = groupCode;

  // FIX: Call actual working functions, not undefined ones
  fetchLiveStandings();
  renderHistory();

  roomChannel = supabaseClient.channel(`group:${currentGroup}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'drinks_logged', filter: `group_code=eq.${currentGroup}` },
      () => {
        console.log('New drink added in this room');
        fetchLiveStandings(); // FIX: Changed from fetchLeaderboard
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
        fetchLiveStandings(); // FIX: Changed from fetchLeaderboard
      }
    )
    .subscribe();
}

// Prompt for username/group code defensively
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
loadBeers();
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
    renderBeerList(beerDatabase);
    
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

    return Object.values(rawBeerObject).map(beer => ({
      wab_beer_id: beer.wab_beer_id || beer.ut_bid,
      beer_name: beer.beer_name || "Unknown Beer",
      brewer_name: beer.brewer_name || "Unknown Brewery",
      abv: beer.abv ? parseFloat(beer.abv).toFixed(1) : "0.0",
      untappd_style: beer.untappd_style || "Other",
      description: cleanHTML(beer.description || "No description provided.")
    }));
  } catch (e) {
    console.error("Parse Error: ", e);
    return [];
  }
}

function cleanHTML(text) {
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]*>/g, '');
}

// ==========================================
// 5. Offline-Ready Logging and Cloud Sync
// ==========================================
function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Robust fallback UUID generation for HTTP mobile testing context
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function logBeer(id) {
  const beer = beerDatabase.find(b => b.wab_beer_id === id);
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
    synced: false
  };

  userProfile.logs.push(newEntry);
  localStorage.setItem('lcbf_logs', JSON.stringify(userProfile.logs));
  
  updateDashboard();
  triggerButtonFeedback();
  syncPendingLogs();
}

async function syncPendingLogs() {
  const pending = userProfile.logs.filter(log => !log.synced);
  if (pending.length === 0 || !navigator.onLine) return;

  for (let log of pending) {
    try {
      const { error } = await supabaseClient
        .from('drinks_logged')
        .insert([{
          id: log.id,
          user_name: userProfile.name,
          group_code: userProfile.groupCode,
          beer_id: log.beer_id,
          beer_name: log.name,
          brewer_name: log.brewer,
          abv: parseFloat(log.abv),
          volume_ml: log.size,
          units: log.units
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
      .select('user_name, units')
      .eq('group_code', userProfile.groupCode);

    if (error) throw error;
    databaseStandings = data || [];
    renderLeaderboard();
  } catch (err) {
    console.warn("Could not fetch server standings (Offline?):", err);
  }
}

function setupRealtimeSync() {
  supabaseClient
    .channel('room-changes')
    .on('postgres_changes', { 
      event: '*', 
      schema: 'public', 
      table: 'drinks_logged',
      filter: `group_code=eq.${userProfile.groupCode}`
    }, () => {
      fetchLiveStandings();
    })
    .subscribe();
}

// ==========================================
// 6. UI Updates and Render Engine
// ==========================================
function updateDashboard() {
  const totalUnits = userProfile.logs.reduce((sum, log) => sum + log.units, 0);
  document.getElementById('totalUnitsText').innerText = totalUnits.toFixed(2);
  document.getElementById('logCount').innerText = userProfile.logs.length;

  const display = document.getElementById('unitDisplay');
  display.className = "px-4 py-2 rounded-xl text-center min-w-24 border transition-colors duration-300 ";
  
  if (totalUnits < 4) {
    display.classList.add('bg-emerald-500/10', 'border-emerald-500/30', 'text-emerald-400');
  } else if (totalUnits < 8) {
    display.classList.add('bg-amber-500/10', 'border-amber-500/30', 'text-amber-400');
  } else {
    display.classList.add('bg-rose-500/10', 'border-rose-500/30', 'text-rose-400');
  }

  renderLeaderboard();
  renderHistory();
}

function renderLeaderboard() {
  const totals = {};

  databaseStandings.forEach(row => {
    if (row.user_name.trim().toLowerCase() !== userProfile.name.trim().toLowerCase()) {
      totals[row.user_name] = (totals[row.user_name] || 0) + parseFloat(row.units);
    }
  });

  const myTotalUnits = userProfile.logs.reduce((sum, log) => sum + log.units, 0);
  totals[userProfile.name + " (You)"] = myTotalUnits;

  const sorted = Object.entries(totals)
    .map(([name, units]) => ({ name, units, isUser: name.includes("(You)") }))
    .sort((a, b) => b.units - a.units);

  const list = document.getElementById('leaderboardList');
  list.innerHTML = sorted.map((person, index) => {
    let rankBadge = `${index + 1}.`;
    if (index === 0) rankBadge = "🥇";
    if (index === 1) rankBadge = "🥈";
    if (index === 2) rankBadge = "🥉";

    return `
      <div class="flex items-center justify-between p-3 rounded-xl border ${person.isUser ? 'bg-festival/10 border-festival/30 text-festival' : 'bg-slate-950 border-slate-800 text-slate-300'}">
        <div class="flex items-center gap-3">
          <span class="text-sm font-black">${rankBadge}</span>
          <span class="font-bold text-sm ${person.isUser ? 'text-slate-100' : ''}">${person.name}</span>
        </div>
        <div class="text-right">
          <span class="text-xs font-semibold block text-slate-500">Units</span>
          <span class="text-sm font-extrabold">${person.units.toFixed(2)}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Fetch current user's personal log history
async function fetchMyHistory() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return;

  // Retrieve only drinks logged by this device
  const { data, error } = await supabaseClient
    .from('drinks_logged')
    .select('*')
    .eq('id', user.id);

  if (error) return console.error(error);
  
  renderMyHistoryList(data); 
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
          <!-- FIX: Pass log.id as a string parameter instead of index -->
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

function editName() {
  const newName = prompt("Enter your name:", userProfile.name);
  if (newName && newName.trim() !== "") {
    userProfile.name = newName.trim();
    localStorage.setItem('lcbf_name', userProfile.name);
    document.getElementById('profileName').firstElementChild.innerText = `${userProfile.name} (${userProfile.groupCode})`;
    updateDashboard();
    syncPendingLogs();
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
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-3 shadow-md hover:border-slate-700 transition-all">
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
            onclick="logBeer(${beer.wab_beer_id})" 
            class="bg-festival text-slate-950 text-xs font-extrabold px-4 py-2 rounded-lg active:scale-95 transition-transform"
          >
            + Log Pour
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function filterBeers() {
  const query = document.getElementById('searchBar').value.toLowerCase();
  const filtered = beerDatabase.filter(beer => 
    beer.beer_name.toLowerCase().includes(query) || 
    beer.brewer_name.toLowerCase().includes(query)
  );
  renderBeerList(filtered);
}

async function removeLog(id) {
  console.log("Target ID for deletion:", id);
  
  const logIndex = userProfile.logs.findIndex(log => log.id === id);
  if (logIndex === -1) {
    console.warn("Log ID not found in local state array.");
    return;
  }

  const logToDelete = userProfile.logs[logIndex];

  // 1. Local UI Update (Optimistic)
  userProfile.logs.splice(logIndex, 1);
  localStorage.setItem('lcbf_logs', JSON.stringify(userProfile.logs));
  updateDashboard();

  // 2. Database Delete
  try {
    // Adding .select() forces Supabase to return the row it deleted
    const { data, error } = await supabaseClient
      .from('drinks_logged')
      .delete()
      .eq('id', id)
      .select();

    if (error) throw error;

    console.log("Supabase delete raw response data:", data);

    if (!data || data.length === 0) {
      console.warn(
        "⚠️ Supabase returned success, but 0 rows were deleted. " +
        "This means EITHER your RLS policies are blocking DELETES, " +
        "OR the ID you sent doesn't match any row in the database."
      );
    } else {
      console.log("✅ Successfully deleted row from Supabase:", data);
    }

    // 3. Refresh live standings locally
    await fetchLiveStandings();

    // 4. Broadcast the removal to other room members
    const activeChannel = roomChannel || supabaseClient.channel(`group:${userProfile.groupCode}`);
    if (activeChannel) {
      await activeChannel.send({
        type: 'broadcast',
        event: 'drink_removed',
        payload: { id }
      });
    }
  } catch (err) {
    console.error("❌ Database delete operation failed completely:", err);
  }
}

async function clearAllLogs() {
  const confirmClear = confirm("Are you sure you want to clear your entire drink history from the database? This cannot be undone.");
  if (!confirmClear) return;

  try {
    // 1. Get the current logged-in anonymous user's ID
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      throw new Error("Could not retrieve your active user session. Try refreshing the page.");
    }

    // 2. Delete ALL records from Supabase matching this user's unique ID
    const { data, error } = await supabaseClient
      .from('drinks_logged')
      .delete()
      .eq('user_id', user.id) // This targets every single database entry they created
      .select();

    if (error) throw error;

    console.log(`Successfully deleted ${data?.length || 0} rows from Supabase.`);

    // 3. Reset local states and UI
    userProfile.logs = [];
    localStorage.setItem('lcbf_logs', JSON.stringify([]));
    updateDashboard();
    renderHistory();

    // 4. Force-refresh local live standings
    await fetchLiveStandings();

    // 5. Broadcast to other room members so their screens update instantly
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

/**
 * Wipes a user's entire drink history from the backend.
 * @param {string} userUuid - The authenticated user's ID.
 */
async function resetUserHistory(userUuid) {
  try {
    const { error } = await supabaseClient
      .from('drinks_logged')
      .delete()
      .eq('uuid', userUuid); // 'uuid' column maps to user ID in your schema

    if (error) throw error;

    return { success: true };
  } catch (err) {
    console.error("Failed to reset history:", err);
    return { success: false, error: err.message };
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

