const installBanner = document.getElementById('pwa-install-banner');
const installButton = document.getElementById('pwa-install-button');
const dismissButton = document.getElementById('pwa-install-dismiss');
const installCopy = document.getElementById('pwa-install-copy');
const iosHelp = document.getElementById('pwa-ios-help');
const dismissalKey = 'fastipo-pwa-install-dismissed-until';
let installPromptEvent = null;

function isIosDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function wasRecentlyDismissed() {
  return Number(localStorage.getItem(dismissalKey) || 0) > Date.now();
}

function showInstallBanner() {
  if (!isInstalled() && !wasRecentlyDismissed()) installBanner.hidden = false;
}

function hideInstallBanner() {
  installBanner.hidden = true;
}

if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.error('Service worker registration failed:', error);
    });
  });
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPromptEvent = event;
  showInstallBanner();
});

window.addEventListener('appinstalled', () => {
  installPromptEvent = null;
  hideInstallBanner();
});

if (isIosDevice() && !isInstalled()) {
  installCopy.textContent = 'Add it to your Home Screen for quick access.';
  installButton.textContent = 'How to install';
  window.setTimeout(showInstallBanner, 1200);
}

installButton.addEventListener('click', async () => {
  if (!installPromptEvent) {
    iosHelp.hidden = !iosHelp.hidden;
    return;
  }

  installPromptEvent.prompt();
  await installPromptEvent.userChoice;
  installPromptEvent = null;
  hideInstallBanner();
});

dismissButton.addEventListener('click', () => {
  localStorage.setItem(dismissalKey, String(Date.now() + 7 * 24 * 60 * 60 * 1000));
  hideInstallBanner();
});