// src/routes/ui.ts
// UI routes - serves the HTML interface for testing jobs

import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Effect } from "effect";

// =============================================================================
// HTML Templates
// =============================================================================

const baseHtml = (title: string, content: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-900 text-gray-100 min-h-screen">
  ${content}
</body>
</html>
`;

const navHtml = `
<nav class="bg-gray-800 border-b border-gray-700 mb-8">
  <div class="container mx-auto px-4 max-w-2xl">
    <div class="flex space-x-4 py-3">
      <a href="/ui/task" class="text-gray-300 hover:text-white px-3 py-2 rounded-lg hover:bg-gray-700 transition">Task</a>
      <a href="/ui/continuous" class="text-gray-300 hover:text-white px-3 py-2 rounded-lg hover:bg-gray-700 transition">Continuous</a>
      <a href="/ui/debounce" class="text-gray-300 hover:text-white px-3 py-2 rounded-lg hover:bg-gray-700 transition">Debounce</a>
    </div>
  </div>
</nav>
`;

// =============================================================================
// Task UI
// =============================================================================

const taskUiHtml = baseHtml(
  "Task Jobs - Durable Effect",
  `
  ${navHtml}
  <div class="container mx-auto px-4 py-4 max-w-2xl">
    <header class="mb-8">
      <h1 class="text-3xl font-bold text-white mb-2">Task Job Demo</h1>
      <p class="text-gray-400">Event-driven durable state machine. Send events, schedule execution.</p>
    </header>

    <!-- Instance ID -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700 mb-6">
      <label class="block text-sm font-medium text-gray-300 mb-2">Instance ID</label>
      <input
        type="text"
        id="instanceId"
        value="my-task"
        class="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-blue-500 outline-none"
      />
    </div>

    <!-- Start Task -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700 mb-6">
      <h2 class="text-lg font-semibold text-white mb-4">Start Task</h2>
      <div class="flex gap-3">
        <input
          type="number"
          id="targetRuns"
          value="3"
          min="1"
          class="w-24 bg-gray-900 border border-gray-600 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-blue-500 outline-none"
        />
        <button onclick="startTask()" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition">
          Start Task (runs N times, 5s apart)
        </button>
      </div>
    </div>

    <!-- Actions -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700 mb-6">
      <h2 class="text-lg font-semibold text-white mb-4">Actions</h2>
      <div class="grid grid-cols-3 gap-3">
        <button onclick="getState()" class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition">Get State</button>
        <button onclick="getStatus()" class="bg-gray-600 hover:bg-gray-700 text-white font-medium py-2 px-4 rounded-lg transition">Get Status</button>
        <button onclick="terminateTask()" class="bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-4 rounded-lg transition">Terminate</button>
      </div>
    </div>

    <!-- Response Log -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-semibold text-white">Log</h2>
        <button onclick="clearLog()" class="text-gray-400 hover:text-white text-sm">Clear</button>
      </div>
      <div id="log" class="bg-gray-900 rounded-lg p-4 font-mono text-sm max-h-80 overflow-y-auto space-y-1">
        <div class="text-gray-500">Responses will appear here...</div>
      </div>
    </div>
  </div>

  <script>
    const getId = () => document.getElementById('instanceId').value || 'my-task';

    const log = (msg, data) => {
      const el = document.getElementById('log');
      const time = new Date().toLocaleTimeString();
      const line = document.createElement('div');
      line.className = 'text-green-400';
      line.innerHTML = '<span class="text-gray-500">[' + time + ']</span> <span class="text-blue-400">' + msg + '</span>: ' + JSON.stringify(data);
      el.insertBefore(line, el.firstChild);
    };

    const clearLog = () => {
      document.getElementById('log').innerHTML = '<div class="text-gray-500">Responses will appear here...</div>';
    };

    const api = async (endpoint, body) => {
      const res = await fetch('/api/jobs/task' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    };

    const startTask = async () => {
      const targetRuns = parseInt(document.getElementById('targetRuns').value) || 3;
      const result = await api('/send', { id: getId(), targetRuns });
      log('send', result);
    };

    const getState = async () => {
      const result = await api('/state', { id: getId() });
      log('state', result);
    };

    const getStatus = async () => {
      const result = await api('/status', { id: getId() });
      log('status', result);
    };

    const terminateTask = async () => {
      const result = await api('/terminate', { id: getId() });
      log('terminate', result);
    };
  </script>
  `
);

// =============================================================================
// Continuous UI
// =============================================================================

const continuousUiHtml = baseHtml(
  "Continuous Jobs - Durable Effect",
  `
  ${navHtml}
  <div class="container mx-auto px-4 py-4 max-w-2xl">
    <header class="mb-8">
      <h1 class="text-3xl font-bold text-white mb-2">Continuous Job Demo</h1>
      <p class="text-gray-400">Heartbeat job that runs every 10 seconds. Auto-terminates after 10 beats.</p>
    </header>

    <!-- Instance ID -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700 mb-6">
      <label class="block text-sm font-medium text-gray-300 mb-2">Instance ID</label>
      <input
        type="text"
        id="instanceId"
        value="my-heartbeat"
        class="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-green-500 outline-none"
      />
    </div>

    <!-- Start Heartbeat -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700 mb-6">
      <h2 class="text-lg font-semibold text-white mb-4">Start Heartbeat</h2>
      <div class="flex gap-3">
        <input
          type="text"
          id="heartbeatName"
          value="My Heartbeat"
          placeholder="Name"
          class="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-green-500 outline-none"
        />
        <button onclick="startHeartbeat()" class="bg-green-600 hover:bg-green-700 text-white font-medium py-2 px-4 rounded-lg transition">
          Start
        </button>
      </div>
      <p class="text-gray-500 text-sm mt-2">Starts a heartbeat that increments every 10 seconds</p>
    </div>

    <!-- Actions -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700 mb-6">
      <h2 class="text-lg font-semibold text-white mb-4">Actions</h2>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <button onclick="getState()" class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition">Get State</button>
        <button onclick="getStatus()" class="bg-gray-600 hover:bg-gray-700 text-white font-medium py-2 px-4 rounded-lg transition">Get Status</button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <button onclick="triggerHeartbeat()" class="bg-yellow-600 hover:bg-yellow-700 text-white font-medium py-2 px-4 rounded-lg transition">Trigger Now</button>
        <button onclick="terminateHeartbeat()" class="bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-4 rounded-lg transition">Terminate</button>
      </div>
    </div>

    <!-- Live State -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700 mb-6">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-semibold text-white">Live State</h2>
        <div class="flex items-center gap-2">
          <span id="autoRefreshStatus" class="text-gray-500 text-sm">Auto-refresh: off</span>
          <button onclick="toggleAutoRefresh()" id="autoRefreshBtn" class="bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium py-1 px-3 rounded transition">
            Enable
          </button>
        </div>
      </div>
      <div id="liveState" class="bg-gray-900 rounded-lg p-4">
        <div class="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span class="text-gray-500">Status:</span>
            <span id="stateStatus" class="text-white ml-2">-</span>
          </div>
          <div>
            <span class="text-gray-500">Count:</span>
            <span id="stateCount" class="text-white ml-2">-</span>
          </div>
          <div>
            <span class="text-gray-500">Name:</span>
            <span id="stateName" class="text-white ml-2">-</span>
          </div>
          <div>
            <span class="text-gray-500">Last Beat:</span>
            <span id="stateLastBeat" class="text-white ml-2">-</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Response Log -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-semibold text-white">Log</h2>
        <button onclick="clearLog()" class="text-gray-400 hover:text-white text-sm">Clear</button>
      </div>
      <div id="log" class="bg-gray-900 rounded-lg p-4 font-mono text-sm max-h-60 overflow-y-auto space-y-1">
        <div class="text-gray-500">Responses will appear here...</div>
      </div>
    </div>
  </div>

  <script>
    const getId = () => document.getElementById('instanceId').value || 'my-heartbeat';
    let autoRefreshInterval = null;

    const log = (msg, data) => {
      const el = document.getElementById('log');
      const time = new Date().toLocaleTimeString();
      const line = document.createElement('div');
      line.className = 'text-green-400';
      line.innerHTML = '<span class="text-gray-500">[' + time + ']</span> <span class="text-blue-400">' + msg + '</span>: ' + JSON.stringify(data);
      el.insertBefore(line, el.firstChild);
    };

    const clearLog = () => {
      document.getElementById('log').innerHTML = '<div class="text-gray-500">Responses will appear here...</div>';
    };

    const api = async (endpoint, body) => {
      const res = await fetch('/api/jobs/continuous' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    };

    const startHeartbeat = async () => {
      const name = document.getElementById('heartbeatName').value || 'My Heartbeat';
      const result = await api('/start', { id: getId(), name });
      log('start', result);
      updateLiveState();
    };

    const terminateHeartbeat = async () => {
      const result = await api('/terminate', { id: getId(), reason: 'User terminated' });
      log('terminate', result);
      updateLiveState();
    };

    const triggerHeartbeat = async () => {
      const result = await api('/trigger', { id: getId() });
      log('trigger', result);
      updateLiveState();
    };

    const getState = async () => {
      const result = await api('/state', { id: getId() });
      log('state', result);
      return result;
    };

    const getStatus = async () => {
      const result = await api('/status', { id: getId() });
      log('status', result);
      return result;
    };

    const updateLiveState = async () => {
      try {
        const [stateRes, statusRes] = await Promise.all([
          api('/state', { id: getId() }),
          api('/status', { id: getId() })
        ]);

        document.getElementById('stateStatus').textContent = statusRes.result?.status || 'not_found';

        const state = stateRes.result?.state;
        if (state) {
          document.getElementById('stateCount').textContent = state.count;
          document.getElementById('stateName').textContent = state.name;
          document.getElementById('stateLastBeat').textContent =
            state.lastHeartbeat ? new Date(state.lastHeartbeat).toLocaleTimeString() : '-';
        } else {
          document.getElementById('stateCount').textContent = '-';
          document.getElementById('stateName').textContent = '-';
          document.getElementById('stateLastBeat').textContent = '-';
        }
      } catch (e) {
        console.error('Failed to update live state', e);
      }
    };

    const toggleAutoRefresh = () => {
      if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        document.getElementById('autoRefreshStatus').textContent = 'Auto-refresh: off';
        document.getElementById('autoRefreshBtn').textContent = 'Enable';
      } else {
        updateLiveState();
        autoRefreshInterval = setInterval(updateLiveState, 2000);
        document.getElementById('autoRefreshStatus').textContent = 'Auto-refresh: 2s';
        document.getElementById('autoRefreshBtn').textContent = 'Disable';
      }
    };
  </script>
  `
);

// =============================================================================
// Debounce UI
// =============================================================================

const debounceUiHtml = baseHtml(
  "Debounce Jobs - Durable Effect",
  `
  ${navHtml}
  <div class="container mx-auto px-4 py-4 max-w-2xl">
    <header class="mb-8">
      <h1 class="text-3xl font-bold text-white mb-2">Debounce Job Demo</h1>
      <p class="text-gray-400">Batch events and flush after 5 seconds of inactivity, or when 10 events accumulated.</p>
    </header>

    <!-- Instance ID -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700 mb-6">
      <label class="block text-sm font-medium text-gray-300 mb-2">Instance ID</label>
      <input
        type="text"
        id="instanceId"
        value="my-debounce"
        class="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-purple-500 outline-none"
      />
    </div>

    <!-- Add Event -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700 mb-6">
      <h2 class="text-lg font-semibold text-white mb-4">Add Event</h2>
      <div class="space-y-3">
        <div class="flex gap-3">
          <input
            type="text"
            id="actionId"
            placeholder="Action ID (auto-generated if empty)"
            class="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-purple-500 outline-none"
          />
          <button onclick="addEvent()" class="bg-purple-600 hover:bg-purple-700 text-white font-medium py-2 px-6 rounded-lg transition">
            Add Event
          </button>
        </div>
        <div class="flex gap-3">
          <input
            type="text"
            id="metadata"
            placeholder="Optional metadata"
            class="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-purple-500 outline-none"
          />
          <button onclick="addMultipleEvents()" class="bg-purple-500 hover:bg-purple-600 text-white font-medium py-2 px-4 rounded-lg transition">
            Add 5 Events
          </button>
        </div>
      </div>
      <p class="text-gray-500 text-sm mt-3">Events are batched. Flush happens after 5s of inactivity or when 10 events are buffered.</p>
    </div>

    <!-- Actions -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700 mb-6">
      <h2 class="text-lg font-semibold text-white mb-4">Actions</h2>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <button onclick="getState()" class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition">Get State</button>
        <button onclick="getStatus()" class="bg-gray-600 hover:bg-gray-700 text-white font-medium py-2 px-4 rounded-lg transition">Get Status</button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <button onclick="flushNow()" class="bg-yellow-600 hover:bg-yellow-700 text-white font-medium py-2 px-4 rounded-lg transition">Flush Now</button>
        <button onclick="clearBuffer()" class="bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-4 rounded-lg transition">Clear Buffer</button>
      </div>
    </div>

    <!-- Live Status -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700 mb-6">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-semibold text-white">Live Status</h2>
        <div class="flex items-center gap-2">
          <span id="autoRefreshStatus" class="text-gray-500 text-sm">Auto-refresh: off</span>
          <button onclick="toggleAutoRefresh()" id="autoRefreshBtn" class="bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium py-1 px-3 rounded transition">
            Enable
          </button>
        </div>
      </div>
      <div id="liveStatus" class="bg-gray-900 rounded-lg p-4">
        <div class="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span class="text-gray-500">Status:</span>
            <span id="statusValue" class="text-white ml-2">-</span>
          </div>
          <div>
            <span class="text-gray-500">Event Count:</span>
            <span id="eventCountValue" class="text-white ml-2">-</span>
          </div>
          <div>
            <span class="text-gray-500">Will Flush At:</span>
            <span id="flushAtValue" class="text-white ml-2">-</span>
          </div>
          <div>
            <span class="text-gray-500">Last Action:</span>
            <span id="lastActionValue" class="text-white ml-2">-</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Response Log -->
    <div class="bg-gray-800 rounded-xl p-6 border border-gray-700">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-semibold text-white">Log</h2>
        <button onclick="clearLog()" class="text-gray-400 hover:text-white text-sm">Clear</button>
      </div>
      <div id="log" class="bg-gray-900 rounded-lg p-4 font-mono text-sm max-h-60 overflow-y-auto space-y-1">
        <div class="text-gray-500">Responses will appear here...</div>
      </div>
    </div>
  </div>

  <script>
    const getId = () => document.getElementById('instanceId').value || 'my-debounce';
    let autoRefreshInterval = null;
    let eventCounter = 0;

    const log = (msg, data) => {
      const el = document.getElementById('log');
      const time = new Date().toLocaleTimeString();
      const line = document.createElement('div');
      line.className = 'text-green-400';
      line.innerHTML = '<span class="text-gray-500">[' + time + ']</span> <span class="text-purple-400">' + msg + '</span>: ' + JSON.stringify(data);
      el.insertBefore(line, el.firstChild);
    };

    const clearLog = () => {
      document.getElementById('log').innerHTML = '<div class="text-gray-500">Responses will appear here...</div>';
    };

    const api = async (endpoint, body) => {
      const res = await fetch('/api/jobs/debounce' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    };

    const addEvent = async () => {
      eventCounter++;
      const actionId = document.getElementById('actionId').value || 'action-' + eventCounter + '-' + Date.now();
      const metadata = document.getElementById('metadata').value || undefined;
      const result = await api('/add', { id: getId(), actionId, metadata });
      log('add', result);
      updateLiveStatus();
      document.getElementById('actionId').value = '';
    };

    const addMultipleEvents = async () => {
      for (let i = 0; i < 5; i++) {
        eventCounter++;
        const actionId = 'batch-' + eventCounter + '-' + Date.now();
        await api('/add', { id: getId(), actionId });
      }
      log('add (5 events)', { success: true });
      updateLiveStatus();
    };

    const flushNow = async () => {
      const result = await api('/flush', { id: getId() });
      log('flush', result);
      updateLiveStatus();
    };

    const clearBuffer = async () => {
      const result = await api('/clear', { id: getId() });
      log('clear', result);
      updateLiveStatus();
    };

    const getState = async () => {
      const result = await api('/state', { id: getId() });
      log('state', result);
      return result;
    };

    const getStatus = async () => {
      const result = await api('/status', { id: getId() });
      log('status', result);
      return result;
    };

    const updateLiveStatus = async () => {
      try {
        const [stateRes, statusRes] = await Promise.all([
          api('/state', { id: getId() }),
          api('/status', { id: getId() })
        ]);

        const status = statusRes.result;
        document.getElementById('statusValue').textContent = status?.status || 'not_found';
        document.getElementById('eventCountValue').textContent = status?.eventCount ?? '-';
        document.getElementById('flushAtValue').textContent =
          status?.willFlushAt ? new Date(status.willFlushAt).toLocaleTimeString() : '-';

        const state = stateRes.result?.state;
        document.getElementById('lastActionValue').textContent = state?.actionId || '-';
      } catch (e) {
        console.error('Failed to update live status', e);
      }
    };

    const toggleAutoRefresh = () => {
      if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        document.getElementById('autoRefreshStatus').textContent = 'Auto-refresh: off';
        document.getElementById('autoRefreshBtn').textContent = 'Enable';
      } else {
        updateLiveStatus();
        autoRefreshInterval = setInterval(updateLiveStatus, 1000);
        document.getElementById('autoRefreshStatus').textContent = 'Auto-refresh: 1s';
        document.getElementById('autoRefreshBtn').textContent = 'Disable';
      }
    };
  </script>
  `
);

// =============================================================================
// Routes
// =============================================================================

export const uiRoutes = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/",
    Effect.succeed(HttpServerResponse.redirect("/ui/task"))
  ),

  HttpRouter.get(
    "/task",
    Effect.gen(function* () {
      return yield* HttpServerResponse.html(taskUiHtml);
    })
  ),

  HttpRouter.get(
    "/continuous",
    Effect.gen(function* () {
      return yield* HttpServerResponse.html(continuousUiHtml);
    })
  ),

  HttpRouter.get(
    "/debounce",
    Effect.gen(function* () {
      return yield* HttpServerResponse.html(debounceUiHtml);
    })
  )
);
