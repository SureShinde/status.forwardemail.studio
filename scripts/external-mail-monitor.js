#!/usr/bin/env node

/**
 * External Mail Provider Status Monitor
 *
 * This script monitors the status of major email providers (Gmail, Outlook.com, iCloud Mail)
 * and automatically creates/updates GitHub issues in the status.forwardemail.net repository
 * when outages are detected.
 *
 * Data Sources:
 * - Google: https://www.google.com/appsstatus/dashboard/en/feed.atom
 * - Apple: https://www.apple.com/support/systemstatus/data/system_status_en_US.js
 * - Microsoft: https://status.cloud.microsoft/api/feed/mac
 *
 * @see https://github.com/forwardemail/status.forwardemail.net
 */

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { parseString } = require('xml2js');

// Configuration
const CONFIG = {
  owner: 'forwardemail',
  repo: 'status.forwardemail.net',
  labels: ['maintenance'],
  stateFile: '.external-mail-status.json',
  feeds: {
    google: {
      url: 'https://www.google.com/appsstatus/dashboard/en/feed.atom',
      name: 'Gmail',
      keywords: ['gmail'],
      type: 'atom'
    },
    apple: {
      url: 'https://www.apple.com/support/systemstatus/data/system_status_en_US.js',
      name: 'iCloud Mail',
      keywords: ['icloud mail'],
      type: 'json'
    },
    microsoft: {
      url: 'https://status.cloud.microsoft/api/feed/mac',
      name: 'Outlook.com / Microsoft 365',
      keywords: ['outlook', 'microsoft 365', 'exchange'],
      type: 'rss'
    }
  }
};

/**
 * Fetch data from a URL
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} - Response body
 */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const request = client.get(url, {
      headers: {
        'User-Agent': 'ForwardEmail-StatusMonitor/1.0',
        Accept: '*/*'
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fetchUrl(response.headers.location).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }

      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => resolve(data));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(30_000, () => {
      request.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

/**
 * Parse XML to JavaScript object
 * @param {string} xml - XML string
 * @returns {Promise<object>} - Parsed object
 */
function parseXml(xml) {
  return new Promise((resolve, reject) => {
    parseString(xml, { explicitArray: false }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/**
 * Format duration from milliseconds
 * @param {number} ms - Duration in milliseconds
 * @returns {string} - Formatted duration
 */
function formatDuration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (remainingMins > 0) {
    return `${hours} hour${hours === 1 ? '' : 's'} ${remainingMins} minute${remainingMins === 1 ? '' : 's'}`;
  }

  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Parse Google Workspace Atom feed for Gmail incidents
 * @returns {Promise<Array>} - Array of incident objects
 */
async function parseGoogleFeed() {
  const incidents = [];

  try {
    const data = await fetchUrl(CONFIG.feeds.google.url);
    const parsed = await parseXml(data);

    if (!parsed.feed || !parsed.feed.entry) {
      return incidents;
    }

    const entries = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];

    // Group entries by incident ID (from link)
    const incidentMap = new Map();

    for (const entry of entries) {
      const link = entry.link?.$ ? entry.link.$.href : (entry.link?.href || entry.link);
      const summary = entry.summary?._ || entry.summary || '';
      const title = entry.title || '';

      // Check if this is Gmail-related
      const isGmail = summary.toLowerCase().includes('gmail') ||
                      title.toLowerCase().includes('gmail') ||
                      summary.toLowerCase().includes('affected products: gmail');

      if (!isGmail) continue;

      // Extract incident ID from link
      const incidentIdMatch = link?.match(/incidents\/([^/]+)/);
      const incidentId = incidentIdMatch ? incidentIdMatch[1] : null;

      if (!incidentId) continue;

      // Only keep the most recent update for each incident
      if (!incidentMap.has(incidentId)) {
        // Check if resolved
        const isResolved = title.toLowerCase().includes('resolved') ||
                          summary.toLowerCase().includes('resolved') ||
                          summary.toLowerCase().includes('issue has been resolved');

        // Extract start time from summary
        const startTimeMatch = summary.match(/incident began at\s*<strong>([^<]+)<\/strong>/i) ||
                              summary.match(/beginning on\s+\w+,\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i);

        // Clean up description
        let description = summary.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        // Extract the main message
        const descMatch = description.match(/Description\s+(.+?)(?:We will provide|$)/i);
        if (descMatch) {
          description = descMatch[1].trim();
        }

        incidents.push({
          provider: 'google',
          service: 'Gmail',
          id: incidentId,
          title: title.split('\n')[0].slice(0, 200),
          description: description.slice(0, 1000),
          link,
          startTime: startTimeMatch ? startTimeMatch[1] : null,
          updated: entry.updated,
          isResolved
        });

        incidentMap.set(incidentId, true);
      }
    }
  } catch (error) {
    console.error('Error parsing Google feed:', error.message);
  }

  return incidents;
}

/**
 * Parse Apple System Status JSON for iCloud Mail incidents
 * @returns {Promise<Array>} - Array of incident objects
 */
async function parseAppleFeed() {
  const incidents = [];

  try {
    const data = await fetchUrl(CONFIG.feeds.apple.url);

    // Apple returns JSONP-like format, extract JSON
    let jsonStr = data;
    if (data.includes('jsonCallback(')) {
      jsonStr = data.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, '');
    }

    const parsed = JSON.parse(jsonStr);

    if (!parsed.services) {
      return incidents;
    }

    for (const service of parsed.services) {
      // Check if this is iCloud Mail
      if (service.serviceName?.toLowerCase() !== 'icloud mail') {
        continue;
      }

      if (!service.events || service.events.length === 0) {
        continue;
      }

      for (const event of service.events) {
        const startTime = event.epochStartDate ? new Date(event.epochStartDate).toISOString() : null;
        const endTime = event.epochEndDate ? new Date(event.epochEndDate).toISOString() : null;
        const isResolved = event.eventStatus === 'resolved';

        // Calculate duration if both times available
        let duration = null;
        if (event.epochStartDate && event.epochEndDate) {
          const durationMs = event.epochEndDate - event.epochStartDate;
          duration = formatDuration(durationMs);
        }

        incidents.push({
          provider: 'apple',
          service: 'iCloud Mail',
          id: event.messageId,
          title: `iCloud Mail ${event.statusType || 'Issue'}`,
          description: event.message || 'iCloud Mail service issue detected.',
          link: 'https://www.apple.com/support/systemstatus/',
          startTime,
          endTime,
          duration,
          updated: event.datePosted,
          isResolved,
          usersAffected: event.usersAffected
        });
      }
    }
  } catch (error) {
    console.error('Error parsing Apple feed:', error.message);
  }

  return incidents;
}

/**
 * Parse Microsoft Status RSS feed for Outlook/M365 incidents
 * @returns {Promise<Array>} - Array of incident objects
 */
async function parseMicrosoftFeed() {
  const incidents = [];

  try {
    const data = await fetchUrl(CONFIG.feeds.microsoft.url);
    const parsed = await parseXml(data);

    if (!parsed.rss || !parsed.rss.channel || !parsed.rss.channel.item) {
      return incidents;
    }

    const items = Array.isArray(parsed.rss.channel.item) ?
      parsed.rss.channel.item : [parsed.rss.channel.item];

    for (const item of items) {
      const title = item.title || '';
      const description = item.description || '';
      const status = item.status || '';

      // Check if this is related to Outlook/Exchange/M365
      const isMailRelated = title.toLowerCase().includes('outlook') ||
                           title.toLowerCase().includes('exchange') ||
                           title.toLowerCase().includes('microsoft 365') ||
                           description.toLowerCase().includes('outlook') ||
                           description.toLowerCase().includes('exchange') ||
                           description.toLowerCase().includes('email');

      // Microsoft MAC feed shows overall status, not specific incidents
      // We'll create an incident if status is not "Available"
      const isOutage = status.toLowerCase() !== 'available';

      if (isOutage || isMailRelated) {
        incidents.push({
          provider: 'microsoft',
          service: 'Outlook.com / Microsoft 365',
          id: item.guid?._ || item.guid || `ms-${Date.now()}`,
          title: title.slice(0, 200),
          description: description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000),
          link: item.link || 'https://status.cloud.microsoft/',
          startTime: item.pubDate,
          updated: item.pubDate,
          isResolved: false,
          status
        });
      }
    }
  } catch (error) {
    console.error('Error parsing Microsoft feed:', error.message);
  }

  return incidents;
}

/**
 * GitHub API request helper
 * @param {string} method - HTTP method
 * @param {string} apiPath - API path
 * @param {object} body - Request body
 * @returns {Promise<object>} - Response data
 */
async function githubApi(method, apiPath, body = null) {
  const token = process.env.GH_PAT || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GitHub token not found. Set GH_PAT or GITHUB_TOKEN environment variable.');
  }

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: apiPath,
      method,
      headers: {
        'User-Agent': 'ForwardEmail-StatusMonitor/1.0',
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub API error ${res.statusCode}: ${parsed.message || data}`));
          } else {
            resolve(parsed);
          }
        } catch (error) {
          reject(new Error(`Failed to parse GitHub response: ${error.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error('GitHub API timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

/**
 * Search for existing issue by incident ID
 * @param {string} incidentId - External incident ID
 * @param {string} provider - Provider name
 * @returns {Promise<object|null>} - Existing issue or null
 */
async function findExistingIssue(incidentId, provider) {
  try {
    const searchQuery = encodeURIComponent(
      `repo:${CONFIG.owner}/${CONFIG.repo} is:issue label:maintenance "${provider}" "${incidentId}" in:body`
    );
    const result = await githubApi('GET', `/search/issues?q=${searchQuery}`);

    if (result.items && result.items.length > 0) {
      return result.items[0];
    }
  } catch (error) {
    console.error('Error searching for existing issue:', error.message);
  }

  return null;
}

/**
 * Create a new GitHub issue for an incident
 * @param {object} incident - Incident data
 * @returns {Promise<object>} - Created issue
 */
async function createIssue(incident) {
  const title = `Investigating ${incident.service} service issues`;

  let body = `Currently monitoring an issue with **${incident.service}** that may affect email delivery.\n\n`;

  body += `## Incident Details\n\n`;
  body += `| Field | Value |\n`;
  body += `|-------|-------|\n`;
  body += `| **Provider** | ${incident.provider.charAt(0).toUpperCase() + incident.provider.slice(1)} |\n`;
  body += `| **Service** | ${incident.service} |\n`;
  body += `| **Incident ID** | \`${incident.id}\` |\n`;
  body += `| **Status** | ${incident.isResolved ? '✅ Resolved' : '🔴 Active'} |\n`;

  if (incident.startTime) {
    body += `| **Started** | ${incident.startTime} |\n`;
  }

  if (incident.endTime) {
    body += `| **Ended** | ${incident.endTime} |\n`;
  }

  if (incident.duration) {
    body += `| **Duration** | ${incident.duration} |\n`;
  }

  if (incident.usersAffected) {
    body += `| **Impact** | ${incident.usersAffected} |\n`;
  }

  body += `\n## Description\n\n${incident.description || incident.title}\n\n`;

  if (incident.link) {
    body += `## Official Status Page\n\n${incident.link}\n\n`;
  }

  body += `---\n\n`;
  body += `> **Note:** Forward Email users may experience delays when sending to or receiving from ${incident.service} during this incident.\n\n`;
  body += `*This issue was automatically created by the external mail provider monitor.*`;

  const issue = await githubApi('POST', `/repos/${CONFIG.owner}/${CONFIG.repo}/issues`, {
    title,
    body,
    labels: CONFIG.labels
  });

  console.log(`Created issue #${issue.number} for ${incident.service} incident ${incident.id}`);
  return issue;
}

/**
 * Update an existing GitHub issue
 * @param {number} issueNumber - Issue number
 * @param {object} incident - Incident data
 * @param {boolean} shouldClose - Whether to close the issue
 * @returns {Promise<void>}
 */
async function updateIssue(issueNumber, incident, shouldClose = false) {
  // Add a comment with the update
  let comment = `## Status Update\n\n`;
  comment += `**Time:** ${new Date().toISOString()}\n`;
  comment += `**Status:** ${incident.isResolved ? '✅ Resolved' : '🔴 Still Active'}\n\n`;

  if (incident.description) {
    comment += `### Latest Update\n\n${incident.description}\n\n`;
  }

  if (incident.duration) {
    comment += `**Total Outage Duration:** ${incident.duration}\n\n`;
  }

  if (incident.isResolved) {
    comment += `---\n\nThe ${incident.service} incident has been resolved.`;
  }

  await githubApi('POST', `/repos/${CONFIG.owner}/${CONFIG.repo}/issues/${issueNumber}/comments`, {
    body: comment
  });

  if (shouldClose) {
    await githubApi('PATCH', `/repos/${CONFIG.owner}/${CONFIG.repo}/issues/${issueNumber}`, {
      state: 'closed',
      state_reason: 'completed'
    });
    console.log(`Closed issue #${issueNumber} - incident resolved`);
  } else {
    console.log(`Updated issue #${issueNumber} with latest status`);
  }
}

/**
 * Load previous state from file
 * @returns {object} - Previous state
 */
function loadState() {
  try {
    const statePath = path.join(process.cwd(), CONFIG.stateFile);
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading state:', error.message);
  }

  return { incidents: {}, lastRun: null };
}

/**
 * Save current state to file
 * @param {object} state - State to save
 */
function saveState(state) {
  try {
    const statePath = path.join(process.cwd(), CONFIG.stateFile);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('Error saving state:', error.message);
  }
}

/**
 * Main monitoring function
 */
async function monitor() {
  console.log(`[${new Date().toISOString()}] Starting external mail provider status check...`);

  const state = loadState();
  const allIncidents = [];

  // Fetch incidents from all providers
  console.log('Checking Google Workspace status...');
  const googleIncidents = await parseGoogleFeed();
  allIncidents.push(...googleIncidents);

  console.log('Checking Apple System Status...');
  const appleIncidents = await parseAppleFeed();
  allIncidents.push(...appleIncidents);

  console.log('Checking Microsoft Status...');
  const microsoftIncidents = await parseMicrosoftFeed();
  allIncidents.push(...microsoftIncidents);

  console.log(`Found ${allIncidents.length} relevant incident(s)`);

  // Process each incident
  for (const incident of allIncidents) {
    const stateKey = `${incident.provider}-${incident.id}`;
    const previousState = state.incidents[stateKey];

    // Check if we've already processed this incident
    if (previousState) {
      // If previously active and now resolved, update and close
      if (!previousState.isResolved && incident.isResolved) {
        console.log(`Incident ${stateKey} has been resolved`);
        if (previousState.issueNumber) {
          await updateIssue(previousState.issueNumber, incident, true);
        }

        state.incidents[stateKey] = {
          ...previousState,
          isResolved: true,
          resolvedAt: new Date().toISOString()
        };
      } else if (!incident.isResolved) {
        // Still active, check if we should update
        const lastUpdate = new Date(previousState.lastUpdate || 0);
        const hoursSinceUpdate = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60);

        // Update every 2 hours for ongoing incidents
        if (hoursSinceUpdate >= 2 && previousState.issueNumber) {
          await updateIssue(previousState.issueNumber, incident, false);
          state.incidents[stateKey].lastUpdate = new Date().toISOString();
        }
      }
    } else if (!incident.isResolved) {
      // New active incident - create issue
      console.log(`New incident detected: ${stateKey}`);
      try {
        // First check if issue already exists (in case state was lost)
        const existingIssue = await findExistingIssue(incident.id, incident.provider);

        if (existingIssue) {
          console.log(`Found existing issue #${existingIssue.number} for incident ${stateKey}`);
          state.incidents[stateKey] = {
            issueNumber: existingIssue.number,
            isResolved: false,
            createdAt: existingIssue.created_at,
            lastUpdate: new Date().toISOString()
          };
        } else {
          const issue = await createIssue(incident);
          state.incidents[stateKey] = {
            issueNumber: issue.number,
            isResolved: false,
            createdAt: new Date().toISOString(),
            lastUpdate: new Date().toISOString()
          };
        }
      } catch (error) {
        console.error(`Failed to create issue for ${stateKey}:`, error.message);
      }
    }
  }

  // Clean up old resolved incidents from state (older than 7 days)
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  for (const [key, value] of Object.entries(state.incidents)) {
    if (value.isResolved && new Date(value.resolvedAt || 0).getTime() < sevenDaysAgo) {
      delete state.incidents[key];
    }
  }

  state.lastRun = new Date().toISOString();
  saveState(state);

  console.log(`[${new Date().toISOString()}] Status check complete`);
}

// Run the monitor
monitor().catch((error) => {
  console.error('Monitor failed:', error);
  process.exit(1);
});
