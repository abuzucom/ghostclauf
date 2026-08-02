import { describe, expect, it } from 'vitest';
import { fireAlert } from '../src/core/alerts.js';
import { makeSpyLogger } from './helpers.js';

describe('fireAlert', () => {
    it('logs at error level with an alert marker and the given kind/details', () => {
        const spy = makeSpyLogger();

        fireAlert(spy.logger, 'token_refresh_failure', { userId: 'user-1' });

        expect(spy.error).toHaveBeenCalledWith(
            expect.objectContaining({
                alert: true,
                kind: 'token_refresh_failure',
                userId: 'user-1',
            }),
            'alert: token_refresh_failure',
        );
    });

    it('spreads arbitrary detail fields onto the log payload', () => {
        const spy = makeSpyLogger();
        const err = new Error('boom');

        fireAlert(spy.logger, 'eventsub_subscription_revoked', {
            subscriptionId: 'sub-1',
            status: 'authorization_revoked',
            err,
        });

        expect(spy.error).toHaveBeenCalledWith(
            expect.objectContaining({
                alert: true,
                kind: 'eventsub_subscription_revoked',
                subscriptionId: 'sub-1',
                status: 'authorization_revoked',
                err,
            }),
            'alert: eventsub_subscription_revoked',
        );
    });
});
