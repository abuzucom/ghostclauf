import {
    applyAward,
    parseEsdAmount,
    renderAdjustDone,
    renderBalance,
    renderLeaderboard,
} from '../dist/plugins/loyalty/loyalty.js';
import { dataToToken } from './helpers.js';

export function fuzz(data) {
    const token = dataToToken(data);
    const amount = parseEsdAmount(token);
    if (amount !== null) {
        applyAward(0, amount);
        renderBalance('esports dollars', 'Viewer', amount);
        renderAdjustDone('esports dollars', 'give', 'Viewer', amount, amount, amount);
    }
    renderLeaderboard('esports dollars', []);
}
