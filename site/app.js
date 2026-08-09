const themeKey = 'ghostclauf-theme';
const archive = { facts: [], quotes: [] };

const factsList = document.querySelector('#facts-list');
const quotesList = document.querySelector('#quotes-list');
const leaderboard = document.querySelector('#leaderboard');
const resultCount = document.querySelector('#result-count');
const query = document.querySelector('#query');
const theme = document.querySelector('#theme');

function createEntry(entry, kind) {
    const article = document.createElement('article');
    article.className = 'archive-entry';
    const text = document.createElement('p');
    text.textContent = entry.text;
    article.append(text);
    const metadata = document.createElement('p');
    metadata.className = 'utility';
    metadata.textContent = kind === 'quote' && entry.speaker ? `Quote: ${entry.speaker}` : kind;
    article.append(metadata);
    return article;
}

function renderArchive(items, container, kind, filter) {
    container.replaceChildren();
    const filtered = items.filter((entry) => {
        const speaker = entry.speaker || '';
        return `${entry.text} ${speaker}`.toLocaleLowerCase().includes(filter);
    });
    if (filtered.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = filter ? 'No matching entries.' : 'No entries published yet.';
        container.append(empty);
    } else {
        filtered.forEach((entry) => container.append(createEntry(entry, kind)));
    }
    return filtered.length;
}

function renderSearch() {
    const filter = query.value.trim().toLocaleLowerCase();
    const factCount = renderArchive(archive.facts, factsList, 'Fun fact', filter);
    const quoteCount = renderArchive(archive.quotes, quotesList, 'Quote', filter);
    resultCount.textContent = `${factCount + quoteCount} matching archive entries`;
}

function renderLeaderboard(entries) {
    leaderboard.replaceChildren();
    entries.forEach((entry) => {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = `${entry.rank}. ${entry.displayName}`;
        const balance = document.createElement('strong');
        balance.textContent = entry.balance.toLocaleString();
        item.append(name, balance);
        leaderboard.append(item);
    });
}

function setTheme(value) {
    document.documentElement.dataset.theme = value;
    theme.value = value;
    localStorage.setItem(themeKey, value);
}

async function loadSnapshot() {
    const response = await fetch('data/public.json');
    if (!response.ok) throw new Error('The public archive is unavailable.');
    const snapshot = await response.json();
    archive.facts = Array.isArray(snapshot.facts) ? snapshot.facts : [];
    archive.quotes = Array.isArray(snapshot.quotes) ? snapshot.quotes : [];
    renderSearch();
    const loyalty = snapshot.loyalty || {};
    document.querySelector('#participant-count').textContent = Number(
        loyalty.participantCount || 0,
    ).toLocaleString();
    document.querySelector('#total-balance').textContent = Number(
        loyalty.totalBalance || 0,
    ).toLocaleString();
    renderLeaderboard(Array.isArray(loyalty.leaderboard) ? loyalty.leaderboard : []);
    document.querySelector('#updated-at').textContent = new Date(
        snapshot.generatedAt,
    ).toLocaleString();
}

theme.addEventListener('change', () => setTheme(theme.value));
query.addEventListener('input', renderSearch);
setTheme(localStorage.getItem(themeKey) || 'dark');
loadSnapshot().catch((error) => {
    resultCount.textContent = error.message;
});
