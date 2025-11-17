import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, collection, query, updateDoc, deleteDoc, serverTimestamp, getDoc } from 'firebase/firestore';
import { RefreshCw, Zap, Monitor, Lock, LogOut, Loader2, Key, Shield, AlertTriangle } from 'lucide-react';

// --- Global Context Variables (Provided by Canvas Environment) ---
// MUST be used for initialization and path construction
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const apiKey = ""; // API Key for Gemini is provided at runtime

// --- Firebase Initialization ---
let app;
let db;
let auth;

if (firebaseConfig) {
  try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
    // setLogLevel('debug'); // Uncomment for debugging Firestore logs
  } catch (e) {
    console.error("Firebase initialization failed:", e);
  }
}

// Helper to handle API call retry logic
const withExponentialBackoff = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      console.warn(`Attempt failed. Retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return withExponentialBackoff(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

// --- Gemini API Call Function ---
const getGeminiAnalysis = async (prompt) => {
  const systemPrompt = `You are the 'Security Posture Analyst' for a global screen mirroring service. Analyze the provided policy or log data based on the user's query. Output a professional, actionable summary in a concise paragraph. Use the data provided by the user as your sole source of information.`;
  
  const userQuery = prompt;
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ parts: [{ text: userQuery }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
  };

  const fn = async () => {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`API call failed with status: ${response.status}`);
    }

    const result = await response.json();
    return result.candidates?.[0]?.content?.parts?.[0]?.text || "Analysis failed to produce content.";
  };

  try {
    return await withExponentialBackoff(fn);
  } catch (error) {
    console.error("Gemini API call failed after retries:", error);
    return `Error: Could not connect to the Gemini API for analysis. (${error.message})`;
  }
};


// --- Core App Component ---
const App = () => {
  const [authReady, setAuthReady] = useState(false);
  const [userId, setUserId] = useState(null);
  const [devices, setDevices] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [simulatedLog, setSimulatedLog] = useState("");
  const [geminiPrompt, setGeminiPrompt] = useState('');
  const [geminiResponse, setGeminiResponse] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState('');

  // Helper function to format the Firestore Timestamp for display
  const formatDate = (timestamp) => {
    if (!timestamp?.toDate) return 'Never';
    try {
        return timestamp.toDate().toLocaleString();
    } catch {
        return 'N/A'; // Handle invalid timestamps gracefully
    }
  };


  // 1. Firebase Authentication Effect
  useEffect(() => {
    if (!auth) return;

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setUserId(user.uid);
      } else if (initialAuthToken) {
        // Sign in with provided token
        try {
          await signInWithCustomToken(auth, initialAuthToken);
        } catch (error) {
          console.error("Custom token sign-in failed:", error);
          await signInAnonymously(auth);
        }
      } else {
        // Sign in anonymously if no token is available
        await signInAnonymously(auth);
      }
      setAuthReady(true);
    });

    return () => unsubscribe();
  }, [auth]); // Added auth to dependency array

  // 2. Firestore Data Fetching (Private: User's Registered Devices)
  useEffect(() => {
    if (!db || !authReady || !userId) return;

    // Path: /artifacts/{appId}/users/{userId}/devices
    const devicesRef = collection(db, 'artifacts', appId, 'users', userId, 'devices');
    const q = query(devicesRef);

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const deviceList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setDevices(deviceList);
    }, (error) => {
      console.error("Error fetching devices:", error);
    });

    return () => unsubscribe();
  }, [authReady, userId]);

  // 3. Firestore Data Fetching (Public: Active Mirroring Session)
  useEffect(() => {
    if (!db || !authReady || !userId) return; // Added userId check here too

    // Path: /artifacts/{appId}/public/data/mirroring_sessions/session_id
    // We use a fixed document ID to represent the 'current' active session state for this user/app.
    const sessionDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'mirroring_sessions', userId);

    const unsubscribe = onSnapshot(sessionDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const sessionData = docSnap.data();
        setActiveSession(sessionData);
      } else {
        setActiveSession(null);
      }
    }, (error) => {
      console.error("Error fetching active session:", error);
    });

    return () => unsubscribe();
  }, [authReady, userId]);

  // --- Utility Functions ---

  const handleAddDevice = useCallback(async () => {
    if (!db || !userId || !newDeviceName.trim()) return;

    const deviceName = newDeviceName.trim();
    // This action simulates the one-time registration of the TV to the user's account
    const newDevice = {
      name: deviceName,
      registeredAt: serverTimestamp(),
      // This property confirms the TV is authorized by the cloud state, allowing "connect from anywhere"
      geoRestriction: 'Country-wide (Cloud Authorized)', 
      uniqueId: crypto.randomUUID().substring(0, 8),
      lastConnected: null, // New field to track last connection time
    };

    try {
      const devicesRef = collection(db, 'artifacts', appId, 'users', userId, 'devices');
      await setDoc(doc(devicesRef), newDevice);
      setNewDeviceName('');
      setSimulatedLog(log => log + `\n[${new Date().toLocaleTimeString()}] SUCCESS: New TV registered (One-time setup complete): ${deviceName} (${userId})`);
    } catch (e) {
      console.error("Error adding device: ", e);
      setSimulatedLog(log => log + `\n[${new Date().toLocaleTimeString()}] ERROR: Failed to register device: ${deviceName}`);
    }
  }, [db, userId, newDeviceName]);


  const handleStartMirroring = useCallback(async (device) => {
    if (!db || !userId) return;

    // Simulate "Security and Restriction" Check: authorization based purely on cloud state (Firestore lookup)
    const isAuthorized = devices.some(d => d.id === device.id);

    if (!isAuthorized) {
      setSimulatedLog(log => log + `\n[${new Date().toLocaleTimeString()}] DENIED: Unauthorized device ID attempted connection: ${device.id}`);
      return;
    }

    if (activeSession && activeSession.status === 'Connected') {
      setSimulatedLog(log => log + `\n[${new Date().toLocaleTimeString()}] DENIED: Already an active session for this user/TV. Privacy violation averted.`);
      return;
    }

    // Attempt to establish session (Public Write)
    const sessionDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'mirroring_sessions', userId);
    const newSession = {
      mirroringDeviceId: device.id,
      mirroringDeviceName: device.name,
      status: 'Connected',
      startTime: serverTimestamp(),
      mirroredBy: userId, // Shows who is currently connected
      geoCheckStatus: 'Passed (Cloud Auth)',
    };

    try {
      // 1. Update the device's last connected timestamp (Private Write)
      const deviceDocRef = doc(db, 'artifacts', appId, 'users', userId, 'devices', device.id);
      await updateDoc(deviceDocRef, {
        lastConnected: serverTimestamp()
      });

      // 2. Set the public session doc (Public Write)
      await setDoc(sessionDocRef, newSession);
      
      setSimulatedLog(log => log + `\n[${new Date().toLocaleTimeString()}] CONNECTED: Session established on TV '${device.name}' (Device ID: ${device.uniqueId}). Geo check passed via cloud authorization.`);
    } catch (e) {
      console.error("Error starting mirroring: ", e);
      setSimulatedLog(log => log + `\n[${new Date().toLocaleTimeString()}] ERROR: Failed to establish connection for ${device.name}`);
    }

  }, [db, userId, devices, activeSession]);


  const handleStopMirroring = useCallback(async () => {
    if (!db || !userId) return;

    try {
      // Deleting the public session doc terminates the mirroring state
      const sessionDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'mirroring_sessions', userId);
      await deleteDoc(sessionDocRef);
      setSimulatedLog(log => log + `\n[${new Date().toLocaleTimeString()}] DISCONNECTED: Session terminated successfully.`);
    } catch (e) {
      console.error("Error stopping mirroring: ", e);
      setSimulatedLog(log => log + `\n[${new Date().toLocaleTimeString()}] ERROR: Failed to terminate session.`);
    }
  }, [db, userId]);


  const handleRunAnalysis = useCallback(async () => {
    if (!geminiPrompt.trim()) {
      setGeminiResponse("Please enter a policy or log detail to analyze.");
      return;
    }

    setIsGenerating(true);
    setGeminiResponse(null);

    const logData = simulatedLog.split('\n').filter(line => line.includes('DENIED')).join('\n');
    let fullPrompt = geminiPrompt;

    if (geminiPrompt.toLowerCase().includes('log')) {
        fullPrompt = `${geminiPrompt}. Use the following log for analysis:\n\n--- SECURITY LOG ---\n${logData || "No denial entries found."}\n------------------`;
    }

    const response = await getGeminiAnalysis(fullPrompt);
    setGeminiResponse(response);
    setIsGenerating(false);
  }, [geminiPrompt, simulatedLog]);


  const statusText = useMemo(() => {
    if (!authReady) return 'Initializing...';
    if (!userId) return 'Awaiting Authentication...';
    if (activeSession && activeSession.status === 'Connected') {
      return `ACTIVE: Mirroring to ${activeSession.mirroringDeviceName}`;
    }
    if (devices.length === 0) return 'No TVs registered. Add one to begin.';
    return 'Idle: Ready to connect.';
  }, [authReady, userId, activeSession, devices]);

  const statusColor = useMemo(() => {
    if (!authReady || !userId) return 'bg-yellow-500';
    if (activeSession && activeSession.status === 'Connected') return 'bg-green-500';
    return 'bg-gray-500';
  }, [authReady, userId, activeSession]);


  return (
    <div className="min-h-screen bg-gray-50 p-6 font-inter antialiased">
      <script src="https://cdn.tailwindcss.com"></script>
      <div className="max-w-7xl mx-auto">

        {/* Header & Status */}
        <header className="mb-8 border-b pb-4">
          <h1 className="text-4xl font-extrabold text-gray-900 flex items-center">
            <Monitor className="w-8 h-8 mr-3 text-indigo-600" />
            {/* ROLLED BACK TITLE */}
            Secure Screen Mirroring Manager
          </h1>
          <p className="text-lg text-gray-500 mt-1">
            {/* ROLLED BACK SUBTITLE */}
            Manage and authorize TV devices for global, secure screen mirroring.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <span className={`px-4 py-2 text-sm font-semibold rounded-full text-white ${statusColor} transition-colors duration-300 shadow-md`}>
              <div className="flex items-center">
                {activeSession?.status === 'Connected' ? <Zap className="w-4 h-4 mr-2" /> : <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {statusText}
              </div>
            </span>
            <span className="flex items-center text-sm text-gray-600">
                <Key className="w-4 h-4 mr-1 text-gray-400" />
                User ID: <code className="ml-1 font-mono text-xs bg-gray-200 px-2 py-0.5 rounded">{userId || 'N/A'}</code>
            </span>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

          {/* Left Column: Device Management */}
          <div className="lg:col-span-1 space-y-8">

            {/* Register TV */}
            <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100">
              <h2 className="text-2xl font-semibold mb-4 flex items-center text-indigo-600">
                <Monitor className="w-6 h-6 mr-2" /> Register New TV (One-Time Setup)
              </h2>
              <div className="space-y-3">
                <input
                  type="text"
                  placeholder="TV Name (e.g., 'Living Room TV')"
                  value={newDeviceName}
                  onChange={(e) => setNewDeviceName(e.target.value)}
                  className="w-full p-3 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
                  disabled={!userId}
                />
                <button
                  onClick={handleAddDevice}
                  className="w-full bg-indigo-500 text-white p-3 rounded-lg font-semibold hover:bg-indigo-600 transition duration-150 disabled:bg-indigo-300 shadow-md"
                  disabled={!userId || !newDeviceName.trim()}
                >
                  Register TV
                </button>
              </div>
            </div>

            {/* Registered Devices List */}
            <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100">
              <h2 className="text-2xl font-semibold mb-4 flex items-center text-indigo-600">
                <Lock className="w-6 h-6 mr-2" /> Authorized Devices ({devices.length})
              </h2>
              <ul className="space-y-3">
                {devices.length === 0 ? (
                  <li className="text-gray-500 italic">No authorized devices found.</li>
                ) : (
                  devices.map(device => (
                    <li key={device.id} className="p-4 bg-gray-50 rounded-lg flex justify-between items-center shadow-sm hover:shadow-md transition">
                      <div>
                        <p className="font-medium text-gray-800">{device.name}</p>
                        <p className="text-xs text-gray-500">
                            <Zap className="w-3 h-3 mr-1 inline" /> ID: {device.uniqueId} | 
                            Last Used: <span className='font-semibold'>{formatDate(device.lastConnected)}</span>
                        </p>
                      </div>
                      <button
                        onClick={() => activeSession?.mirroringDeviceId === device.id ? handleStopMirroring() : handleStartMirroring(device)}
                        className={`text-xs font-bold py-2 px-3 rounded-full transition duration-150 ${activeSession?.mirroringDeviceId === device.id
                            ? 'bg-red-500 text-white hover:bg-red-600'
                            : 'bg-green-500 text-white hover:bg-green-600'
                          }`}
                        disabled={!userId}
                      >
                        {activeSession?.mirroringDeviceId === device.id ? 'STOP' : 'START MIRROR'}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>

          {/* Right Column: Security/Gemini Analysis */}
          <div className="lg:col-span-2 space-y-8">

            {/* Gemini Security Analysis Tool */}
            <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100">
              <h2 className="text-2xl font-semibold mb-4 flex items-center text-purple-600">
                <Shield className="w-6 h-6 mr-2" /> ADK Gemini Security Analyst
              </h2>
              <p className="text-gray-600 mb-4">
                Analyze your connection policy or review denial logs instantly.
              </p>

              <div className="space-y-4">
                <textarea
                  placeholder="E.g., 'Analyze the policy: only one user can mirror at a time from a registered device.' or 'Summarize the denial patterns in the log.'"
                  value={geminiPrompt}
                  onChange={(e) => setGeminiPrompt(e.target.value)}
                  rows="3"
                  className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500 resize-none"
                />
                <button
                  onClick={handleRunAnalysis}
                  className="w-full bg-purple-500 text-white p-3 rounded-lg font-semibold hover:bg-purple-600 transition duration-150 shadow-md flex items-center justify-center disabled:bg-purple-300"
                  disabled={isGenerating || !userId || !geminiPrompt.trim()}
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Generating Analysis...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-5 h-5 mr-2" />
                      Run Policy Analysis
                    </>
                  )}
                </button>
              </div>

              {geminiResponse && (
                <div className="mt-6 p-4 bg-purple-50 border-l-4 border-purple-400 rounded-lg">
                  <h3 className="font-bold text-purple-800 mb-2 flex items-center">
                    <LogOut className="w-4 h-4 mr-2" /> Gemini Output
                  </h3>
                  <p className="text-purple-700 whitespace-pre-wrap">{geminiResponse}</p>
                </div>
              )}
            </div>

            {/* Simulated Security Log */}
            <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100">
              <h2 className="text-2xl font-semibold mb-4 flex items-center text-red-600">
                <AlertTriangle className="w-6 h-6 mr-2" /> Security and Connection Log
              </h2>
              <div className="h-64 overflow-y-scroll bg-gray-800 text-green-400 font-mono text-xs p-3 rounded-lg shadow-inner">
                {simulatedLog.trim() === '' ? (
                  <p className="text-gray-500 italic">Log is empty. Start adding devices or connections to generate entries.</p>
                ) : (
                  simulatedLog.split('\n').map((line, index) => (
                    <pre key={index} className={line.includes('DENIED') ? 'text-red-400' : ''}>{line}</pre>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;