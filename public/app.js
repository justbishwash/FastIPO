// Replace this with your deployed Cloudflare Worker URL.
const PROXY_URL = "https://meroshare-api.mkn.com.np"; 
const BASE_URL = `${PROXY_URL}/api/meroShare`;
const BO_URL = `${PROXY_URL}/api/meroShareView`;
const BANK_BASE = `${PROXY_URL}/api/bankRequest`;

let vault = [];
let vaultEncryptionKey = null;
let availableOpenings = [];
let primaryMeroShareClient = null;
const openingDetailsCache = new Map();
let minimumKittaRequestId = 0;
let pendingAccount = null;
let applicationReportState = {
  all: [],
  page: 1,
  pageSize: 10,
  accountFilter: 'all',
};
localStorage.removeItem('meroshare_vault');

function log(msg) {
  const logs = document.getElementById('logs');
  const time = new Date().toLocaleTimeString();
  logs.innerHTML += `<div>[${time}] ${msg}</div>`;
  logs.scrollTop = logs.scrollHeight;
}

// ==========================================
// Web Crypto API (AES-256-GCM)
// ==========================================
async function createVaultEncryptionKey() {
  const key = await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
  );
  return Array.from(new Uint8Array(await window.crypto.subtle.exportKey("raw", key)));
}

async function encryptData(data, keyBytes) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const key = await window.crypto.subtle.importKey(
    "raw", new Uint8Array(keyBytes), { name: "AES-GCM" }, false, ["encrypt"]
  );
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(JSON.stringify(data))
  );
  return {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(ciphertext))
  };
}

async function decryptData(encryptedObj, keyBytes) {
  const iv = new Uint8Array(encryptedObj.iv);
  const ciphertext = new Uint8Array(encryptedObj.data);
  const key = await window.crypto.subtle.importKey(
    "raw", new Uint8Array(keyBytes), { name: "AES-GCM" }, false, ["decrypt"]
  );
  const decrypted = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv }, key, ciphertext
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

let firebaseAuth = null;
let firebaseDb = null;
let cloudUser = null;
let vaultOpenPromise = null;

function isFirebaseConfigured() {
  return window.FIREBASE_CONFIG
    && window.FIREBASE_CONFIG.apiKey
    && !window.FIREBASE_CONFIG.apiKey.startsWith('PASTE_');
}

function setCloudAuthStatus(message, isError = false) {
  const status = document.getElementById('cloud-auth-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function updateUserProfile(user) {
  const name = document.getElementById('user-display-name');
  const email = document.getElementById('user-email');
  const initials = document.getElementById('user-avatar-initials');
  const image = document.getElementById('user-avatar-image');
  if (!name || !email || !initials || !image) return;

  if (!user) {
    name.textContent = 'My Workspace';
    email.textContent = 'Personal Account';
    initials.textContent = 'MS';
    image.removeAttribute('src');
    image.style.display = 'none';
    initials.style.display = 'inline';
    return;
  }

  const displayName = user.displayName || user.email || 'Google User';
  const nameParts = displayName.trim().split(/\s+/).filter(Boolean);
  const userInitials = nameParts.length > 1
    ? `${nameParts[0][0]}${nameParts[nameParts.length - 1][0]}`
    : displayName.slice(0, 2);
  name.textContent = displayName;
  email.textContent = user.email || 'Google account';
  document.getElementById('menu-user-name').textContent = displayName;
  document.getElementById('menu-user-email').textContent = user.email || 'Google account';
  initials.textContent = userInitials.toUpperCase();

  if (user.photoURL) {
    image.src = user.photoURL;
    image.style.display = 'block';
    initials.style.display = 'none';
  } else {
    image.removeAttribute('src');
    image.style.display = 'none';
    initials.style.display = 'inline';
  }
}

async function signOutUser() {
  try {
    MeroShareClient.sharedToken = null;
    MeroShareClient.sharedTokenKey = null;
    if (firebaseAuth) await firebaseAuth.signOut();
    vault = [];
    vaultEncryptionKey = null;
    window.location.reload();
  } catch (error) {
    showApplicationToast('error', 'Sign out failed', error.message);
  }
}

function initCloudVault() {
  if (!isFirebaseConfigured()) {
    setCloudAuthStatus('Firebase is not configured. Google sign-in is unavailable.', true);
    return;
  }

  try {
    firebase.initializeApp(window.FIREBASE_CONFIG);
    firebaseAuth = firebase.auth();
    firebaseDb = firebase.firestore();
    firebaseAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    firebaseAuth.onAuthStateChanged(async (user) => {
      cloudUser = user;
      updateUserProfile(user);
      if (!user) {
        setCloudAuthStatus('Sign in to sync your vault across devices.');
        return;
      }

      setCloudAuthStatus(`Signed in as ${user.email || user.displayName || 'Google user'}.`);
      try {
        if (!vaultOpenPromise) {
          vaultOpenPromise = openCloudVault();
        }
        await vaultOpenPromise;
      } catch (error) {
        setCloudAuthStatus(`Signed in, but vault could not be opened: ${error.message}`, true);
      } finally {
        vaultOpenPromise = null;
      }
    });
  } catch (error) {
    setCloudAuthStatus('Cloud backup is unavailable. Local vault remains active.', true);
    log(`[ERROR] Firebase setup failed: ${error.message}`);
  }
}

async function signInWithGoogle() {
  if (!firebaseAuth) {
    setCloudAuthStatus('Configure Firebase before signing in.', true);
    return;
  }

  try {
    setCloudAuthStatus('Opening Google sign-in...');
    await firebaseAuth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
  } catch (error) {
    if (error.code === 'auth/popup-blocked') {
      await firebaseAuth.signInWithRedirect(new firebase.auth.GoogleAuthProvider());
      return;
    }
    setCloudAuthStatus(`Google sign-in failed: ${error.message}`, true);
    showApplicationToast('error', 'Google sign-in failed', error.message);
  }
}

async function cloudLoadVault() {
  if (!cloudUser || !firebaseDb) return null;
  const snapshot = await firebaseDb.collection('vaults').doc(cloudUser.uid).get({ source: 'server' });
  return snapshot.exists ? snapshot.data() : null;
}

async function cloudSaveVault(encryptedVault, encryptionKey) {
  if (!cloudUser || !firebaseDb) return;
  await firebaseDb.collection('vaults').doc(cloudUser.uid).set({
    encryptedVault,
    encryptionKey,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

function enterApplication() {
  document.getElementById('unlock-section').classList.add('d-none');
  document.getElementById('main-app').classList.remove('d-none');
  renderAccounts();
  window.setTimeout(async () => {
    await loadOpenings();
    await loadApplicationReport();
  }, 1000);
}

async function openCloudVault() {
  const remoteVault = await cloudLoadVault();

  if (remoteVault && remoteVault.encryptedVault && !remoteVault.encryptionKey) {
    throw new Error('This Google vault uses the old password format. Export or remove the old vault before starting a new Google-only vault.');
  }

  if (remoteVault && remoteVault.encryptedVault && remoteVault.encryptionKey) {
    vaultEncryptionKey = remoteVault.encryptionKey;
    vault = await decryptData(remoteVault.encryptedVault, vaultEncryptionKey);
    if (!Array.isArray(vault)) throw new Error('Vault data is not a valid account list.');
    enterApplication();
    log(`[OK] Vault restored from cloud: ${vault.length} account(s).`);
    return;
  }

  vault = [];
  vaultEncryptionKey = await createVaultEncryptionKey();

  await saveVault();
  enterApplication();
  log("[OK] Google vault is ready.");
}

// ==========================================
// 🏦 MeroShare API Client
// ==========================================
class MeroShareClient {
  static sharedToken = null;
  static sharedTokenKey = null;

  constructor({ username, password, dpId, pin }) {
    this.username = username;
    this.password = password;
    this.dpId = dpId;
    this.pin = pin;
    this.accountTokenKey = `${this.dpId || ''}:${this.username || ''}`;
    this.token = MeroShareClient.sharedTokenKey === this.accountTokenKey
      ? MeroShareClient.sharedToken
      : null;
  }

  async fetchClientId() {
    const res = await fetch(`${BASE_URL}/capital/`, { method: "GET", headers: { "Content-Type": "application/json" } });
    if (!res.ok) throw new Error(`Failed to fetch clientId: ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("Invalid response from /capital/");
    const client = data.find((c) => c.code === this.dpId);
    if (!client) throw new Error(`Broker with code "${this.dpId}" not found`);
    return client.id;
  }

  async login() {
    if (this.token && MeroShareClient.sharedTokenKey === this.accountTokenKey) {
      this.token = MeroShareClient.sharedToken;
      return this.token;
    }

    const clientId = await this.fetchClientId();
    const loginRes = await fetch(`${BASE_URL}/auth/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password, clientId }),
    });
    if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status}`);
    const loginData = await loginRes.json();
    if (loginData.statusCode !== 200) throw new Error(`Login failed: ${loginData.message}`);
    
    this.token = loginRes.headers.get("authorization");
    if (!this.token) throw new Error("No authorization token received!");

    MeroShareClient.sharedToken = this.token;
    MeroShareClient.sharedTokenKey = this.accountTokenKey;
    return this.token;
  }

  async authFetch(url, options = {}) {
    if (!this.token
      && MeroShareClient.sharedTokenKey === this.accountTokenKey
      && MeroShareClient.sharedToken) {
      this.token = MeroShareClient.sharedToken;
    }
    if (!this.token) await this.login();
    let res = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: this.token, "Content-Type": "application/json" },
    });
    if (res.status === 401) {
      log("[WARN] Token expired. Signing in again...");
      MeroShareClient.sharedToken = null;
      MeroShareClient.sharedTokenKey = null;
      await this.login();
      res = await fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: this.token, "Content-Type": "application/json" },
      });
    }
    return res;
  }

  async fetchOwnDetail() {
    const res = await this.authFetch(`${PROXY_URL}/api/meroShare/ownDetail/`);
    if (!res.ok) throw new Error(`Failed to fetch own detail: ${res.status}`);
    return res.json();
  }

  async fetchIssueDetails(companyShareId) {
    const res = await this.authFetch(`${BASE_URL}/active/${companyShareId}`);
    if (!res.ok) throw new Error(`Failed to fetch issue details: ${res.status}`);
    return res.json();
  }

  async fetchApplicableIssues() {
    const res = await this.authFetch(`${BASE_URL}/companyShare/applicableIssue/`, {
      method: "POST",
      body: JSON.stringify({
        filterFieldParams: [
          { key: "companyIssue.companyISIN.script", alias: "Scrip" },
          { key: "companyIssue.companyISIN.company.name", alias: "Company Name" },
          { key: "companyIssue.assignedToClient.name", value: "", alias: "Issue Manager" },
        ],
        page: 1,
        size: 10,
        searchRoleViewConstants: "VIEW_APPLICABLE_SHARE",
        filterDateParams: [
          { key: "minIssueOpenDate", condition: "", alias: "", value: "" },
          { key: "maxIssueCloseDate", condition: "", alias: "", value: "" },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Failed to fetch IPOs: ${res.status}`);
    return res.json();
  }

  async fetchApplicantForms({ page = 1, size = 200 } = {}) {
    const res = await this.authFetch(`${BASE_URL}/applicantForm/active/search/`, {
      method: "POST",
      body: JSON.stringify({
        filterFieldParams: [
          { key: "companyShare.companyIssue.companyISIN.script", alias: "Scrip" },
          { key: "companyShare.companyIssue.companyISIN.company.name", alias: "Company Name" }
        ],
        page,
        size,
        searchRoleViewConstants: "VIEW_APPLICANT_FORM_COMPLETE",
        filterDateParams: [
          { key: "appliedDate", condition: "", alias: "", value: "" },
          { key: "appliedDate", condition: "", alias: "", value: "" }
        ]
      }),
    });
    if (!res.ok) throw new Error(`Failed to fetch application report: ${res.status}`);
    return res.json();
  }

  async fetchApplicantFormDetail(applicantFormId) {
    const res = await this.authFetch(`${BASE_URL}/applicantForm/report/detail/${applicantFormId}`);
    if (!res.ok) throw new Error(`Failed to fetch application detail: ${res.status}`);
    return res.json();
  }

  async fetchIPOs() {
    return (await this.fetchApplicableIssues()).object || [];
  }

  async fetchBODetails(boid) {
    const res = await this.authFetch(`${BO_URL}/myDetail/${boid}`);
    if (!res.ok) throw new Error(`Failed to fetch BO details: ${res.status}`);
    return res.json();
  }

  async applyForIPO({ targetScript, appliedKitta = "10", crnNumber }) {
    const ipoList = await this.fetchIPOs();
    const share = ipoList.find((i) => i.scrip.toUpperCase() === targetScript.toUpperCase());
    if (!share) throw new Error(`Target IPO "${targetScript}" not found!`);
    log(`[OK] Target IPO found: ${share.companyName} (${share.scrip})`);

    const ownDetail = await this.fetchOwnDetail();
    const boid = ownDetail.demat;

    const boData = await this.fetchBODetails(boid);
    const { bankCode, boid: demat } = boData;

    const bankReqRes = await this.authFetch(`${BANK_BASE}/${bankCode}`);
    if (!bankReqRes.ok) throw new Error(`Failed to fetch bank request: ${bankReqRes.status}`);
    const bankReqData = await bankReqRes.json();
    const bankId = bankReqData.bank.id;

    const bankRes = await this.authFetch(`${BASE_URL}/bank/${bankId}`);
    if (!bankRes.ok) throw new Error(`Failed to fetch bank account: ${bankRes.status}`);
    const bankAccounts = await bankRes.json();
    const bankAccount = bankAccounts[0];
    if (!bankAccount) throw new Error("No bank account found for this user.");
    
    const { id: customerId, accountBranchId, accountNumber: registeredAccountNumber } = bankAccount;

    const payload = {
      accountBranchId, accountNumber: registeredAccountNumber, accountTypeId: 1, appliedKitta,
      bankId: bankId.toString(), boid: this.username, companyShareId: share.companyShareId.toString(),
      crnNumber, customerId, demat, transactionPIN: this.pin,
    };

    const applyRes = await this.authFetch(`${BASE_URL}/applicantForm/share/apply`, { method: "POST", body: JSON.stringify(payload) });
    if (!applyRes.ok) {
      let message = `HTTP ${applyRes.status}`;
      const responseText = await applyRes.text();
      try {
        const error = JSON.parse(responseText);
        message = error.message || error.error || message;
      } catch (parseError) {
        if (responseText) message = responseText;
      }
      throw new Error(`IPO application failed: ${message}`);
    }

    const applyData = await applyRes.json();
    log(`[OK] IPO application successful. Ref: ${applyData.referenceNo || "N/A"}`);
    return applyData;
  }
}

// ==========================================
// 🖥️ UI & Vault Management
// ==========================================
function renderOpenings(openings) {
  const list = document.getElementById('openings-list');
  if (!openings.length) {
    list.innerHTML = '<div class="openings-empty">No share openings are available right now.</div>';
    return;
  }

  list.innerHTML = openings.map((opening) => `
    <div class="opening-row">
      <div>
        <strong>${opening.companyName || 'Unknown company'}</strong>
        <span>${opening.scrip || 'N/A'} - ${opening.shareTypeName || 'Share issue'}</span>
      </div>
      <div class="opening-dates">
        <span>Opens ${opening.issueOpenDate || 'N/A'}</span>
        <span>Closes ${opening.issueCloseDate || 'N/A'}</span>
      </div>
    </div>
  `).join('');
}

function populateApplicationReportFilters() {
  const filter = document.getElementById('application-report-account-filter');
  if (!filter) return;

  const existingValue = filter.value || 'all';
  filter.innerHTML = '<option value="all">All Accounts</option>';

  vault.forEach((account) => {
    const label = account.name || account.username || 'Unknown account';
    const option = document.createElement('option');
    option.value = label;
    option.textContent = label;
    if (existingValue === label) option.selected = true;
    filter.appendChild(option);
  });

  if (existingValue && existingValue !== 'all' && !vault.some((account) => (account.name || account.username) === existingValue)) {
    filter.value = 'all';
  } else {
    filter.value = existingValue;
  }

  applicationReportState.accountFilter = filter.value || 'all';
}

function renderApplicationReport(applications) {
  const list = document.getElementById('application-report-list');
  const status = document.getElementById('application-report-status');
  const filter = document.getElementById('application-report-account-filter');
  const pageSizeSelector = document.getElementById('application-report-page-size');
  if (!list || !status) return;

  const selectedAccount = filter ? filter.value || 'all' : 'all';
  applicationReportState.accountFilter = selectedAccount;

  const filteredApplications = selectedAccount === 'all'
    ? applications
    : applications.filter((entry) => (entry.accountName || '').toLowerCase() === selectedAccount.toLowerCase());

  status.textContent = `${filteredApplications.length} total`;

  if (!filteredApplications.length) {
    list.innerHTML = '<div class="openings-empty">No IPO applications found for your saved accounts.</div>';
    return;
  }

  const pageSize = Number(pageSizeSelector ? pageSizeSelector.value : applicationReportState.pageSize) || 10;
  applicationReportState.pageSize = pageSize;
  const totalPages = Math.max(1, Math.ceil(filteredApplications.length / pageSize));
  if (applicationReportState.page > totalPages) applicationReportState.page = totalPages;

  const startIndex = (applicationReportState.page - 1) * pageSize;
  const paginated = filteredApplications.slice(startIndex, startIndex + pageSize);

  const rows = paginated.map((entry) => {
    const rawStatusName = entry.statusName
      || entry.allotmentStatusName
      || entry.applicationStatusName
      || entry.status
      || 'PENDING';
    const normalizedRawStatus = String(rawStatusName).toUpperCase();
    const hasAllotmentResult = ['isAllotted', 'allotted', 'isAlloted']
      .find((key) => entry[key] !== undefined && entry[key] !== null);
    const allotmentResult = hasAllotmentResult ? entry[hasAllotmentResult] : undefined;
    const isAllotted = allotmentResult === true || String(allotmentResult).toLowerCase() === 'true';
    const isNotAllotted = allotmentResult === false || String(allotmentResult).toLowerCase() === 'false';
    const statusName = normalizedRawStatus === 'BLOCKED_APPROVE'
      ? 'Verified'
      : normalizedRawStatus === 'TRANSACTION_SUCCESS' && isAllotted
        ? 'Alloted'
        : normalizedRawStatus === 'TRANSACTION_SUCCESS' && isNotAllotted
          ? 'Not Alloted'
          : rawStatusName;
    const normalizedStatus = String(statusName).toUpperCase();
    const statusTone = normalizedStatus.includes('NOT ALLOT')
      ? 'not-allotted'
      : normalizedStatus.includes('ALLOT')
        ? 'allotted'
        : 'other';
    const reasonOrRemark = entry.reasonOrRemark
      || entry.reason
      || entry.remark
      || entry.remarks
      || (normalizedRawStatus === 'BLOCKED_APPROVE' ? 'Block Amount Status - Amount Blocked' : '')
      || (normalizedRawStatus === 'TRANSACTION_SUCCESS' ? 'Block Amount Status - Amount Released' : '');
    const accountName = entry.accountName || 'Unknown account';
    const scrip = entry.scrip || 'N/A';
    const companyName = entry.companyName || 'Unknown company';
    const shareTypeName = entry.shareTypeName || 'IPO';
    const applicantFormId = entry.applicantFormId || 'N/A';
    const appliedKitta = entry.appliedKitta ?? 'N/A';
    const receivedKitta = entry.receivedKitta ?? 'N/A';

    return `
      <tr>
        <td>
          <div class="application-report-company">${companyName}</div>
          <div class="application-report-script">${scrip}</div>
        </td>
        <td>${shareTypeName}</td>
        <td>${appliedKitta}</td>
        <td>${receivedKitta}</td>
        <td>
          <span class="application-report-account">${accountName}</span>
        </td>
        <td>${applicantFormId}</td>
        <td>
          <div class="application-report-status ${statusTone}">${statusName}</div>
          ${reasonOrRemark ? `<div class="application-report-reason">${reasonOrRemark}</div>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  const startRow = filteredApplications.length === 0 ? 0 : startIndex + 1;
  const endRow = Math.min(startIndex + pageSize, filteredApplications.length);

  list.innerHTML = `
    <table class="application-report-table">
      <thead>
        <tr>
          <th>Company</th>
          <th>Type</th>
          <th>Applied Kitta</th>
          <th>Received Kitta</th>
          <th>Account</th>
          <th>Application ID</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    <div class="application-report-pagination">
      <div class="application-report-pagination-meta">Showing ${startRow}-${endRow} of ${filteredApplications.length}</div>
      <div class="application-report-pagination-controls">
        <button type="button" data-report-page="prev" ${applicationReportState.page <= 1 ? 'disabled' : ''}>Previous</button>
        <button type="button" data-report-page="next" ${applicationReportState.page >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
    </div>
  `;

  const prevBtn = list.querySelector('[data-report-page="prev"]');
  const nextBtn = list.querySelector('[data-report-page="next"]');
  if (prevBtn) prevBtn.addEventListener('click', () => {
    if (applicationReportState.page > 1) {
      applicationReportState.page -= 1;
      renderApplicationReport(applicationReportState.all);
    }
  });
  if (nextBtn) nextBtn.addEventListener('click', () => {
    if (applicationReportState.page < totalPages) {
      applicationReportState.page += 1;
      renderApplicationReport(applicationReportState.all);
    }
  });
}

async function loadApplicationReport() {
  const list = document.getElementById('application-report-list');
  if (!list) return;

  if (!vault.length) {
    applicationReportState.all = [];
    applicationReportState.page = 1;
    renderApplicationReport([]);
    return;
  }

  list.innerHTML = '<div class="openings-empty">Loading application report...</div>';

  const mergedReports = [];

  for (const account of vault) {
    try {
      const client = new MeroShareClient(account);
      const response = await client.fetchApplicantForms();
      const applications = Array.isArray(response.object) ? response.object : [];
      const detailedApplications = await Promise.all(applications.map(async (item) => {
        if (!item.applicantFormId) return item;

        try {
          const detail = await client.fetchApplicantFormDetail(item.applicantFormId);
          return { ...item, ...detail };
        } catch (error) {
          log(`[WARN] Failed to load detail for application ${item.applicantFormId}: ${error.message}`);
          return item;
        }
      }));

      mergedReports.push(...detailedApplications.map((item) => ({
        ...item,
        accountName: account.name || account.username || 'Unknown account'
      })));
    } catch (error) {
      log(`[ERROR] Failed to load application report for ${account.name || account.username}: ${error.message}`);
    }
  }

  applicationReportState.all = mergedReports;
  applicationReportState.page = 1;
  populateApplicationReportFilters();
  renderApplicationReport(mergedReports);
}

async function loadOpenings() {
  const count = document.getElementById('opening-count');
  const status = document.getElementById('openings-status');
  const list = document.getElementById('openings-list');
  const primaryAccount = getPrimaryAccount();
  if (!primaryAccount) return;

  count.textContent = '...';
  status.textContent = 'Loading';
  list.innerHTML = '<div class="openings-empty">Loading current openings...</div>';

  try {
    primaryMeroShareClient = new MeroShareClient(primaryAccount);
    const data = await primaryMeroShareClient.fetchApplicableIssues();
    const openings = Array.isArray(data.object) ? data.object : [];
    const totalOpenings = Number(data.totalCount) > 0 ? Number(data.totalCount) : openings.length;
    populateOpeningPicker(openings);
    count.textContent = totalOpenings;
    status.textContent = `${totalOpenings} opening${totalOpenings === 1 ? '' : 's'}`;
    renderOpenings(openings);
    log(`[OK] Loaded ${totalOpenings} current share opening(s).`);
  } catch (error) {
    count.textContent = '--';
    status.textContent = 'Unavailable';
    list.innerHTML = '<div class="openings-empty">Could not load openings. Check the activity log.</div>';
    log(`[ERROR] Failed to load openings: ${error.message}`);
  }
}

async function saveVault() {
  if (!cloudUser || !firebaseDb) throw new Error('Google sign-in is required before saving accounts.');
  if (!vaultEncryptionKey) vaultEncryptionKey = await createVaultEncryptionKey();
  const encrypted = await encryptData(vault, vaultEncryptionKey);
  await cloudSaveVault(encrypted, vaultEncryptionKey);
  log("[OK] Vault saved to Firestore.");
}

async function loadDPs() {
  try {
    const res = await fetch(`${BASE_URL}/capital/`);
    const data = await res.json();
    const datalist = document.getElementById('dp-list');
    datalist.innerHTML = '';
    data.forEach(dp => {
      const option = document.createElement('option');
      option.value = dp.code;
      option.label = `${dp.name} (${dp.code})`; // Shows as "SUN SECURITIES PVT LTD (19300)"
      datalist.appendChild(option);
    });
    log("[OK] DP list loaded.");
  } catch (e) {
    log("[ERROR] Failed to load DP list. Check the proxy URL.");
  }
}

function isBsDateString(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 40;
}

function formatBsDate(value) {
  if (!value) return 'Not available';
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return trimmed;

  const [, year, month, day] = match;
  return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
}

function getExpiryText(expiryDateStr, type = 'days') {
  if (!expiryDateStr || expiryDateStr === 'Unknown') {
    return type === 'bs-date' ? 'Date unavailable' : 'Expiry unavailable';
  }

  const value = String(expiryDateStr).trim();
  if (!value) {
    return type === 'bs-date' ? 'Date unavailable' : 'Expiry unavailable';
  }

  if (type === 'bs-date') {
    return isBsDateString(value) ? formatBsDate(value) : value;
  }

  const maybeDays = Number(value);
  if (Number.isFinite(maybeDays) && maybeDays >= 0) {
    return `${maybeDays} days`;
  }

  const expiry = new Date(value);
  if (Number.isNaN(expiry.getTime())) {
    return value;
  }

  const today = new Date();
  const diffTime = expiry - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return 'Expired';
  return `${diffDays} days`;
}

function resolveExpiryValue(detail, keys) {
  for (const key of keys) {
    const value = detail?.[key];
    const normalizedValue = value === undefined || value === null ? '' : String(value).trim();
    if (normalizedValue && normalizedValue.toLowerCase() !== 'unknown') {
      return value;
    }
  }
  return null;
}

function renderAccounts() {
  const list = document.getElementById('accounts-list');
  const select = document.getElementById('apply-account');
  if (!list || !select) return;

  if (!vault.length) {
    list.innerHTML = '<div class="openings-empty">No saved accounts yet. Add your first MeroShare account.</div>';
    select.innerHTML = '<option value="">Select an account</option>';
    return;
  }

  const rows = vault.map((acc, idx) => {
    const displayName = acc.name || acc.username;
    const passwordExpiryText = getExpiryText(acc.passwordExpiryDate, 'days');
    const dematExpiryText = acc.dematExpiryDate ? getExpiryText(acc.dematExpiryDate, 'bs-date') : 'Date unavailable';
    const meroShareExpiry = resolveExpiryValue(acc, [
      'meroShareExpiryDate',
      'meroshareExpiryDate',
      'expiredDateStr',
      'expiredDate',
      'expirationDateStr',
      'expirationDate'
    ]);
    const meroShareExpiryText = meroShareExpiry ? getExpiryText(meroShareExpiry, 'days') : 'Expiry unavailable';
    const isPrimary = !!acc.primary;

    return `
      <tr>
        <td>
          <div class="account-table-name">${displayName}</div>
          <div class="account-table-subtext">BOID: ${acc.boid || 'N/A'}</div>
        </td>
        <td>
          <span class="account-expiry-pill ${passwordExpiryText.includes('expired') ? 'expired' : ''}">${passwordExpiryText}</span>
        </td>
        <td>
          <span class="account-expiry-pill ${dematExpiryText.includes('expired') ? 'expired' : ''}">${dematExpiryText}</span>
        </td>
        <td>
          <span class="account-expiry-pill ${meroShareExpiryText.includes('expired') ? 'expired' : ''}">${meroShareExpiryText}</span>
        </td>
        <td>
          <div class="account-table-actions">
            <button class="btn btn-sm ${isPrimary ? 'btn-primary' : 'btn-outline-primary'} account-action-btn" onclick="setPrimaryAccount(${idx})" title="${isPrimary ? 'Primary account' : 'Set as primary'}">
              <i class="bi ${isPrimary ? 'bi-star-fill' : 'bi-star'}"></i>
            </button>
            <button class="btn btn-sm btn-outline-primary account-action-btn" onclick="editAccount(${idx})" title="Edit account">
              <i class="bi bi-pencil-square"></i>
            </button>
            <button class="btn btn-sm btn-outline-danger account-action-btn" onclick="removeAccount(${idx})" title="Remove account">
              <i class="bi bi-trash3"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  list.innerHTML = `
    <table class="accounts-table">
      <thead>
        <tr>
          <th>Account</th>
          <th>Password Expiry</th>
          <th>Demat Expiry</th>
          <th>MeroShare Expiry</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;

  select.innerHTML = '<option value="">Select an account</option>';
  vault.forEach((acc, idx) => {
    const option = document.createElement('option');
    option.value = idx;
    option.textContent = `${acc.name || acc.username} (${acc.dpId})`;
    select.appendChild(option);
  });

}

function getPrimaryAccount() {
  return vault.find((account) => account.primary) || vault[0];
}

window.setPrimaryAccount = async function(idx) {
  vault.forEach((account, accountIndex) => {
    account.primary = accountIndex === idx;
  });
  await saveVault();
  renderAccounts();
  loadOpenings();
  loadApplicationReport();
};

function populateOpeningPicker(openings) {
  const picker = document.getElementById('opening-script-list');
  if (!picker) return;
  availableOpenings = openings;

  picker.innerHTML = openings.map((opening) => {
    const script = opening.scrip || '';
    const company = opening.companyName || 'Unknown company';
    return `<option value="${company}">${script}</option>`;
  }).join('');
}

function findOpeningForInput(value) {
  const normalizedValue = value.trim().toUpperCase();
  return availableOpenings.find((opening) => (
    (opening.companyName || '').toUpperCase() === normalizedValue
    || (opening.scrip || '').toUpperCase() === normalizedValue
  ));
}

function getOpeningMinimumKitta(opening) {
  const minimumKitta = opening.minAppliedKitta
    ?? opening.minimumAppliedKitta
    ?? opening.minimumKitta
    ?? opening.minKitta;
  const parsedMinimumKitta = Number(minimumKitta);
  return Number.isFinite(parsedMinimumKitta) && parsedMinimumKitta > 0 ? parsedMinimumKitta : null;
}

async function updateMinimumKitta() {
  const inputValue = document.getElementById('apply-script').value.trim();
  const kittaInput = document.getElementById('apply-kitta');
  const hint = document.getElementById('minimum-kitta-hint');
  const opening = findOpeningForInput(inputValue);
  const requestId = ++minimumKittaRequestId;

  if (!opening || !opening.companyShareId) {
    hint.textContent = '';
    kittaInput.removeAttribute('min');
    return;
  }

  hint.textContent = 'Loading minimum kitta...';

  try {
    let details = openingDetailsCache.get(opening.companyShareId);
    if (!details) {
      const primaryAccount = getPrimaryAccount();
      if (!primaryAccount) throw new Error('No primary account is available.');
      if (!primaryMeroShareClient) {
        primaryMeroShareClient = new MeroShareClient(primaryAccount);
      }
      details = await primaryMeroShareClient.fetchIssueDetails(opening.companyShareId);
      openingDetailsCache.set(opening.companyShareId, details);
    }

    if (requestId !== minimumKittaRequestId) return;
    const minimumKitta = Number(details.minUnit);
    if (!Number.isFinite(minimumKitta) || minimumKitta <= 0) {
      hint.textContent = 'Minimum kitta is not available';
      kittaInput.removeAttribute('min');
      return;
    }

    hint.textContent = `Minimum kitta is ${minimumKitta}`;
    kittaInput.min = minimumKitta;
    kittaInput.step = Number(details.multipleOf) > 0 ? details.multipleOf : 1;
    kittaInput.value = minimumKitta;
  } catch (error) {
    if (requestId !== minimumKittaRequestId) return;
    hint.textContent = 'Could not load minimum kitta';
    kittaInput.removeAttribute('min');
    log(`[ERROR] Failed to load minimum kitta for ${inputValue}: ${error.message}`);
  }
}

window.removeAccount = function(idx) {
  const removedAccount = vault[idx];
  if (!removedAccount) return;
  vault.splice(idx, 1);
  if (vault.length && !vault.some((account) => account.primary)) vault[0].primary = true;
  saveVault().then(() => {
    renderAccounts();
    loadApplicationReport();
    showApplicationToast('success', 'Account removed', `${removedAccount.name || removedAccount.username} was removed.`);
  }).catch((error) => {
    vault.splice(idx, 0, removedAccount);
    renderAccounts();
    loadApplicationReport();
    showApplicationToast('error', 'Account not removed', error.message);
  });
};

function setAccountModalStage(stage) {
  document.querySelectorAll('.account-credential-field').forEach((field) => {
    field.classList.toggle('d-none', stage !== 'credentials');
  });
  document.querySelectorAll('.account-dp-field').forEach((field) => {
    field.classList.toggle('d-none', stage === 'bank' || stage === 'final');
  });
  document.querySelectorAll('.account-bank-field').forEach((field) => {
    field.classList.toggle('d-none', stage !== 'bank' && stage !== 'final');
  });
  document.querySelectorAll('.account-final-field').forEach((field) => {
    field.classList.toggle('d-none', stage !== 'final');
  });
  document.querySelectorAll('.account-step').forEach((step) => {
    const stepName = step.dataset.accountStep;
    const isActive = stepName === stage || (stage === 'final' && stepName === 'bank');
    step.classList.toggle('active', isActive);
    step.classList.toggle('complete',
      (stage === 'credentials' && stepName === 'dp')
      || (stage === 'bank' && (stepName === 'dp' || stepName === 'credentials'))
      || (stage === 'final' && stepName !== 'bank')
    );
  });
}

function resetAccountModal() {
  pendingAccount = null;
  document.getElementById('add-account-form').reset();
  setAccountModalStage('credentials');
  const verifyButton = document.getElementById('verify-account-btn');
  verifyButton.disabled = false;
  verifyButton.innerHTML = '<i class="bi bi-shield-check"></i> Verify Credentials';
  document.getElementById('acc-bank-name').value = '';
  document.getElementById('acc-bank-account').value = '';
}

document.getElementById('add-account-modal').addEventListener('show.bs.modal', resetAccountModal);

document.getElementById('verify-account-btn').addEventListener('click', async () => {
  const username = document.getElementById('acc-username').value.trim();
  const password = document.getElementById('acc-password').value;
  const dpId = document.getElementById('acc-dp').value.trim();
  const verifyButton = document.getElementById('verify-account-btn');

  if (!dpId || !username || !password) {
    showApplicationToast('error', 'Missing account details', 'Select a DP and enter your username and password.');
    return;
  }

  verifyButton.disabled = true;
  verifyButton.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Verifying...';
  log(`[INFO] Verifying credentials for ${username}...`);

  try {
    const accountTokenKey = `${dpId}:${username}`;
    if (MeroShareClient.sharedTokenKey !== accountTokenKey) {
      MeroShareClient.sharedToken = null;
      MeroShareClient.sharedTokenKey = null;
    }

    const client = new MeroShareClient({ username, password, dpId });
    await client.login();
    const detail = await client.fetchOwnDetail();
    const boData = await client.fetchBODetails(detail.demat);
    const rawBankName = boData.bankName || '';
    const bankName = rawBankName.split('-')[0].trim().replace(/\.$/, '');

    pendingAccount = {
      client,
      username,
      password,
      dpId,
      detail,
      bankName,
      bankAccountNumber: boData.accountNumber || ''
    };

    document.getElementById('acc-bank-name').value = bankName;
    document.getElementById('acc-bank-account').value = boData.accountNumber || '';
    setAccountModalStage('final');
    verifyButton.innerHTML = '<i class="bi bi-check-circle-fill"></i> Verified';
    log(`[OK] Verified ${username}; bank details loaded.`);
  } catch (err) {
    verifyButton.disabled = false;
    verifyButton.innerHTML = '<i class="bi bi-shield-check"></i> Verify Credentials';
    log(`[ERROR] Verification failed: ${err.message}`);
    showApplicationToast('error', 'Verification failed', err.message);
  }
});

document.getElementById('add-account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pendingAccount) return;

  const pin = document.getElementById('acc-pin').value;
  const crn = document.getElementById('acc-crn').value;
  if (!pin || !crn) {
    showApplicationToast('error', 'Missing final details', 'Enter transaction PIN and CRN number.');
    return;
  }

  const { username, password, dpId, detail } = pendingAccount;
  const accountName = detail.name && detail.name.trim() !== "" ? detail.name : username;
  const passwordExpiryDate = resolveExpiryValue(detail, ['passwordExpiryDateStr', 'passwordExpiryDate', 'passwordExpiry']) || 'Unknown';
  const dematExpiryDate = resolveExpiryValue(detail, ['dematExpiryDate', 'dematExpiryDateStr', 'demat_expiry_date', 'dematExpiry']) || 'Unknown';
  const meroShareExpiryDate = resolveExpiryValue(detail, ['expiredDateStr', 'expiredDate', 'meroShareExpiryDate', 'meroshareExpiryDate', 'expirationDateStr', 'expirationDate']) || 'Unknown';

  try {
    const bankName = pendingAccount.bankName;
    vault.push({
      username,
      password,
      dpId,
      pin,
      crn,
      name: accountName,
      boid: detail.demat,
      bankName,
      bankAccountNumber: pendingAccount.bankAccountNumber,
      passwordExpiryDate,
      dematExpiryDate,
      meroShareExpiryDate,
      primary: vault.length === 0
    });

    await saveVault();
    renderAccounts();
    loadOpenings();
    loadApplicationReport();
    document.getElementById('add-account-form').reset();
    resetAccountModal();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('add-account-modal')).hide();
    log(`[OK] Saved ${accountName} with ${bankName}.`);
  } catch (err) {
    vault.pop();
    log(`[ERROR] Account save failed: ${err.message}`);
    showApplicationToast('error', 'Account could not be saved', err.message);
  }
});

function showApplicationToast(type, title, message) {
  const container = document.getElementById('app-toasts') || document.getElementById('application-toasts');
  const toast = document.createElement('div');
  toast.className = `application-toast ${type}`;
  toast.innerHTML = `
    <i class="bi ${type === 'success' ? 'bi-check-circle-fill' : 'bi-exclamation-triangle-fill'}"></i>
    <div><strong>${title}</strong><span>${message}</span></div>
  `;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  window.setTimeout(() => {
    toast.classList.remove('visible');
    window.setTimeout(() => toast.remove(), 250);
  }, 7000);
}

function updateApplicationProgress(completed, total, message) {
  const progress = document.getElementById('application-progress');
  const label = document.getElementById('application-progress-label');
  const counter = document.getElementById('application-progress-count');
  const bar = document.getElementById('application-progress-bar');
  progress.classList.remove('d-none');
  label.textContent = message;
  counter.textContent = `${completed} / ${total}`;
  bar.style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
}

document.getElementById('apply-ipo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const applyAll = document.getElementById('apply-all-accounts').checked;
  const accIdx = document.getElementById('apply-account').value;
  if (!applyAll && accIdx === "") {
    showApplicationToast('error', 'Account required', 'Select an account or enable all accounts.');
    return;
  }

  const opening = findOpeningForInput(document.getElementById('apply-script').value);
  const appliedKitta = document.getElementById('apply-kitta').value;
  const formCrn = document.getElementById('apply-crn').value;
  if (!opening) {
    showApplicationToast('error', 'Opening required', 'Select an opening from the list.');
    return;
  }

  const targetScript = opening.scrip;

  const accounts = applyAll ? vault : [vault[accIdx]];
  const form = e.currentTarget;
  const button = form.querySelector('.apply-btn');
  const buttonLabel = document.getElementById('apply-button-label');
  const controls = form.querySelectorAll('input, select, button');
  const selectedOpening = opening.companyName || targetScript.toUpperCase();
  let completed = 0;
  let successful = 0;

  controls.forEach((control) => { control.disabled = true; });
  button.classList.add('is-applying');
  buttonLabel.textContent = accounts.length > 1 ? 'Applying...' : 'Processing...';
  updateApplicationProgress(0, accounts.length, `Applying ${selectedOpening}`);
  log(`[INFO] Starting ${accounts.length} application(s) for ${selectedOpening}...`);

  for (const account of accounts) {
    const displayName = account.name || account.username;
    const crnNumber = applyAll ? account.crn : formCrn;
    try {
      const client = new MeroShareClient(account);
      await client.applyForIPO({ targetScript, appliedKitta, crnNumber });
      successful += 1;
      showApplicationToast('success', 'Application successful', `${displayName} applied for ${selectedOpening}.`);
      log(`[OK] ${displayName} applied successfully for ${selectedOpening}.`);
    } catch (err) {
      showApplicationToast('error', 'Application failed', `${displayName}: ${err.message}`);
      log(`[ERROR] ${displayName} application failed: ${err.message}`);
    } finally {
      completed += 1;
      updateApplicationProgress(completed, accounts.length, completed === accounts.length ? 'Applications complete' : `Applying ${selectedOpening}`);
    }
  }

  button.classList.remove('is-applying');
  buttonLabel.textContent = `Done: ${successful}/${accounts.length}`;
  controls.forEach((control) => { control.disabled = false; });
  document.getElementById('apply-account').disabled = applyAll;
});

// Init
document.getElementById('google-sign-in-btn').addEventListener('click', signInWithGoogle);
document.querySelector('.user-profile').addEventListener('click', (event) => {
  if (event.target.closest('#logout-btn')) return;
  const menu = document.getElementById('user-menu');
  menu.hidden = !menu.hidden;
});
document.getElementById('logout-btn').addEventListener('click', signOutUser);
document.addEventListener('click', (event) => {
  if (!event.target.closest('.user-profile')) document.getElementById('user-menu').hidden = true;
});
initCloudVault();
loadDPs();

document.getElementById('apply-account').addEventListener('change', function() {
  const idx = this.value;
  if (idx !== "") {
    document.getElementById('apply-crn').value = vault[idx].crn || '';
  } else {
    document.getElementById('apply-crn').value = '';
  }
});

document.getElementById('apply-script').addEventListener('input', updateMinimumKitta);
document.getElementById('apply-script').addEventListener('change', updateMinimumKitta);

document.getElementById('apply-all-accounts').addEventListener('change', function() {
  const accountSelect = document.getElementById('apply-account');
  const crnGroup = document.getElementById('apply-crn-group');
  const crnInput = document.getElementById('apply-crn');
  accountSelect.disabled = this.checked;
  crnGroup.classList.toggle('d-none', this.checked);
  crnInput.required = !this.checked;
  if (this.checked) {
    accountSelect.value = '';
    crnInput.value = '';
  }
});

const applicationReportAccountFilter = document.getElementById('application-report-account-filter');
if (applicationReportAccountFilter) {
  applicationReportAccountFilter.addEventListener('change', function() {
    applicationReportState.accountFilter = this.value || 'all';
    applicationReportState.page = 1;
    renderApplicationReport(applicationReportState.all);
  });
}

const applicationReportPageSize = document.getElementById('application-report-page-size');
if (applicationReportPageSize) {
  applicationReportPageSize.addEventListener('change', function() {
    applicationReportState.pageSize = Number(this.value) || 10;
    applicationReportState.page = 1;
    renderApplicationReport(applicationReportState.all);
  });
}
