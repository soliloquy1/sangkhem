/**
 * Runs Observe once per message after its text settles. A new event for the same message restarts
 * the timer, and aborts a run in progress because the text it read is out of date.
 * Runs happen one at a time, in the order they start, so each reply's observe builds on the state
 * the previous reply's observe wrote (group chats, catch-up).
 */
export class ObserveScheduler {
    constructor({ run, onError = () => {} }) {
        this.run = run;
        this.onError = onError;
        /** @type {Map<number, { timer: any, controller: AbortController|null, promise: Promise|null }>} */
        this.jobs = new Map();
        this.tail = Promise.resolve();
    }

    schedule(mesId, delayMs) {
        const job = this.jobs.get(mesId) ?? { timer: null, controller: null, promise: null };
        if (job.timer !== null) clearTimeout(job.timer);
        job.controller?.abort();
        job.controller = null;
        job.promise = null;
        job.timer = setTimeout(() => { this.start(mesId); }, delayMs);
        this.jobs.set(mesId, job);
    }

    start(mesId) {
        let job = this.jobs.get(mesId);
        if (!job) {
            job = { timer: null, controller: null, promise: null };
            this.jobs.set(mesId, job);
        }
        if (job.timer !== null) {
            clearTimeout(job.timer);
            job.timer = null;
        }
        if (job.promise) return job.promise;
        const controller = new AbortController();
        job.controller = controller;
        job.promise = this.tail
            .then(() => (controller.signal.aborted ? undefined : this.run(mesId, controller.signal)))
            .catch((error) => {
                if (!controller.signal.aborted) this.onError(error, mesId);
            })
            .finally(() => {
                if (this.jobs.get(mesId) === job && job.controller === controller) this.jobs.delete(mesId);
            });
        this.tail = job.promise;
        return job.promise;
    }

    cancel(mesId) {
        const job = this.jobs.get(mesId);
        if (!job) return;
        if (job.timer !== null) clearTimeout(job.timer);
        job.controller?.abort();
        this.jobs.delete(mesId);
    }

    cancelAll() {
        for (const mesId of [...this.jobs.keys()]) this.cancel(mesId);
    }

    isPending(mesId) {
        return this.jobs.has(mesId);
    }

    /** Starts a waiting job now and waits up to waitMs. Resolves true if it finished in time. */
    async flush(mesId, waitMs) {
        if (!this.jobs.has(mesId)) return true;
        const promise = this.start(mesId);
        let timer;
        const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitMs); });
        const finished = await Promise.race([promise.then(() => true), timedOut]);
        clearTimeout(timer);
        return finished;
    }
}
