// The site moved from its old workers.dev address to inspicio.app. Visitors who arrive at the old
// address go to the same page on the new one. Branch preview URLs have other hostnames, so they
// stay where they are. This runs before anything else on the page and reads nothing but the URL.
if (location.hostname === 'inspicio.johnnythan.workers.dev') {
  location.replace('https://inspicio.app' + location.pathname + location.search + location.hash);
}
