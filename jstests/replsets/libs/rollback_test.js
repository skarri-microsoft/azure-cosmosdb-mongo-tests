/**
 *
 * Wrapper around ReplSetTest for testing rollback behavior. It allows the caller to easily
 * transition between stages of a rollback without having to manually operate on the replset.
 *
 * This library exposes the following 5 sequential stages of rollback:
 * 1. RollbackTest starts in kSteadyStateOps: the replica set is in steady state replication.
 *        Operations applied will be replicated.
 * 2. kRollbackOps: operations applied during this phase will not be replicated and eventually be
 *        rolled back.
 * 3. kSyncSourceOpsBeforeRollback: apply operations on the sync source before rollback begins.
 * 4. kSyncSourceOpsDuringRollback: apply operations on the sync source after rollback has begun.
 * 5. kSteadyStateOps: (same as stage 1) with the option of waiting for the rollback to finish.
 *
 * Please refer to the various `transition*` functions for more information on the behavior
 * of each stage.
 */

"use strict";

load("jstests/replsets/rslib.js");
load("jstests/replsets/libs/two_phase_drops.js");
load("jstests/hooks/validate_collections.js");

/**
 *
 * This fixture allows the user to optionally pass in a custom ReplSetTest
 * to be used for the test. The underlying replica set must meet the following
 * requirements:
 *      1. It must have exactly three nodes: A primary and two secondaries. One of the secondaries
 *         must be configured with priority: 0 so that it won't be elected primary. Throughout
 *         this file, this secondary will be referred to as the tiebreaker node.
 *      2. It must be running with mongobridge.
 *
 * If the caller does not provide their own replica set, a standard three-node
 * replset will be initialized instead, with all nodes running the latest version.
 *
 * @param {string} [optional] name the name of the test being run
 * @param {Object} [optional] replSet the ReplSetTest instance to adopt
 */
function RollbackTest(name = "RollbackTest", replSet) {
    const State = {
        kStopped: "kStopped",
        kRollbackOps: "kRollbackOps",
        kSyncSourceOpsBeforeRollback: "kSyncSourceOpsBeforeRollback",
        kSyncSourceOpsDuringRollback: "kSyncSourceOpsDuringRollback",
        kSteadyStateOps: "kSteadyStateOps",
    };

    const AcceptableTransitions = {
        [State.kStopped]: [],
        [State.kRollbackOps]: [State.kSyncSourceOpsBeforeRollback],
        [State.kSyncSourceOpsBeforeRollback]: [State.kSyncSourceOpsDuringRollback],
        [State.kSyncSourceOpsDuringRollback]: [State.kSteadyStateOps],
        [State.kSteadyStateOps]: [State.kStopped, State.kRollbackOps],
    };

    const collectionValidator = new CollectionValidator();

    const SIGKILL = 9;
    const SIGTERM = 15;
    const kNumDataBearingNodes = 3;
    const kElectableNodes = 2;

    let rst;
    let curPrimary;
    let curSecondary;
    let tiebreakerNode;

    let curState = State.kSteadyStateOps;
    let lastRBID;

    // Make sure we have a replica set up and running.
    replSet = (replSet === undefined) ? performStandardSetup() : replSet;
    validateAndUseSetup(replSet);

    // Majority writes in the initial phase, before transitionToRollbackOperations(), should be
    // replicated to the syncSource node so they aren't lost when syncSource steps up. Ensure that
    // majority writes can be acknowledged only by syncSource, not by tiebreakerNode.
    jsTestLog(`Stopping replication on ${tiebreakerNode.host}`);
    stopServerReplication(tiebreakerNode);

    /**
     * Validate and use the provided replica set.
     *
     * @param {Object} replSet the ReplSetTest instance to adopt
     */
    function validateAndUseSetup(replSet) {
        assert.eq(true,
                  replSet instanceof ReplSetTest,
                  `Must provide an instance of ReplSetTest. Have: ${tojson(replSet)}`);

        assert.eq(true, replSet.usesBridge(), "Must set up ReplSetTest with mongobridge enabled.");
        assert.eq(3, replSet.nodes.length, "Replica set must contain exactly three nodes.");

        // Make sure we have a primary.
        curPrimary = replSet.getPrimary();

        // Extract the other two nodes and wait for them to be ready.
        let secondaries = replSet.getSecondaries();
        let config = replSet.getReplSetConfigFromNode();

        // Make sure chaining is disabled, so that the tiebreaker cannot be used as a sync source.
        assert.eq(config.settings.chainingAllowed,
                  false,
                  "Must set up ReplSetTest with chaining disabled.");

        // Make sure the primary is not a priority: 0 node.
        assert.neq(0, config.members[0].priority);
        assert.eq(config.members[0].host, curPrimary.host);

        // Make sure that of the two secondaries, one is a priority: 0 node and the other is not.
        assert.neq(config.members[1].priority, config.members[2].priority);

        curSecondary = (config.members[1].priority !== 0) ? secondaries[0] : secondaries[1];
        tiebreakerNode = (config.members[2].priority === 0) ? secondaries[1] : secondaries[0];

        waitForState(curSecondary, ReplSetTest.State.SECONDARY);
        waitForState(tiebreakerNode, ReplSetTest.State.SECONDARY);

        rst = replSet;
        lastRBID = assert.commandWorked(curSecondary.adminCommand("replSetGetRBID")).rbid;

        // Insert a document and replicate it to all 3 nodes so that any of the nodes can sync from
        // any other. If we do not do this, then due to initial sync timing and sync source
        // selection all nodes may not be guaranteed to have overlapping oplogs.
        const dbName = "EnsureAnyNodeCanSyncFromAnyOther";
        assert.commandWorked(curPrimary.getDB(dbName).ensureSyncSource.insert(
            {thisDocument: 'is inserted to ensure any node can sync from any other'},
            {writeConcern: {w: 3}}));
    }

    /**
     * Return an instance of ReplSetTest initialized with a standard
     * three-node replica set running with the latest version.
     *
     * Note: One of the secondaries will have a priority of 0.
     */
    function performStandardSetup() {
        let nodeOptions = {};
        if (TestData.logComponentVerbosity) {
            nodeOptions["setParameter"] = {
                "logComponentVerbosity": tojsononeline(TestData.logComponentVerbosity)
            };
        }
        if (TestData.syncdelay) {
            nodeOptions["syncdelay"] = TestData.syncdelay;
        }

        let replSet = new ReplSetTest({name, nodes: 3, useBridge: true, nodeOptions: nodeOptions});
        replSet.startSet();

        let config = replSet.getReplSetConfig();
        config.members[2].priority = 0;
        config.settings = {chainingAllowed: false};
        replSet.initiate(config);

        assert.eq(replSet.nodes.length,
                  kNumDataBearingNodes,
                  "Mismatch between number of data bearing nodes and test configuration.");

        return replSet;
    }

    function checkDataConsistency(
        {skipCheckCollectionCounts: skipCheckCollectionCounts = false} = {}) {
        assert.eq(curState,
                  State.kSteadyStateOps,
                  "Not in kSteadyStateOps state, cannot check data consistency");

        // We must wait for collection drops to complete so that we don't get spurious failures
        // in the consistency checks.
        rst.nodes.forEach(TwoPhaseDropCollectionTest.waitForAllCollectionDropsToComplete);

        const name = rst.name;
        // We must check counts before we validate since validate fixes counts. We cannot check
        // counts if unclean shutdowns occur.
        if ((!TestData.allowUncleanShutdowns || !TestData.rollbackShutdowns) &&
            !skipCheckCollectionCounts) {
            rst.checkCollectionCounts(name);
        }
        rst.checkOplogs(name);
        rst.checkReplicatedDataHashes(name);
        collectionValidator.validateNodes(rst.nodeList());
    }

    function log(msg, important = false) {
        if (important) {
            jsTestLog(`[${name}] ${msg}`);
        } else {
            print(`[${name}] ${msg}`);
        }
    }

    /**
     * return whether the cluster can transition from the current State to `newState`.
     * @private
     */
    function transitionIfAllowed(newState) {
        if (AcceptableTransitions[curState].includes(newState)) {
            log(`Transitioning to: "${newState}"`, true);
            curState = newState;
        } else {
            // Transitioning to a disallowed State is likely a bug in the code, so we throw an
            // error here instead of silently failing.
            throw new Error(`Can't transition to State "${newState}" from State "${curState}"`);
        }
    }

    /**
     * Transition from a rollback state to a steady state. Operations applied in this phase will
     * be replicated to all nodes and should not be rolled back.
     */
    this.transitionToSteadyStateOperations = function({skipDataConsistencyChecks = false} = {}) {
        // If we shut down the primary before the secondary begins rolling back against it, then
        // the secondary may get elected and not actually roll back. In that case we do not check
        // the RBID and just await replication.
        if (!TestData.rollbackShutdowns) {
            log(`Waiting for rollback to complete on ${curSecondary.host}`, true);
            let rbid = -1;
            assert.soon(() => {
                try {
                    rbid = assert.commandWorked(curSecondary.adminCommand("replSetGetRBID")).rbid;
                } catch (e) {
                    // Command can fail when sync source is being cleared.
                }
                // Fail early if the rbid is greater than lastRBID+1.
                assert.lte(rbid,
                           lastRBID + 1,
                           `RBID is too large. current RBID: ${rbid}, last RBID: ${lastRBID}`);

                return rbid === lastRBID + 1;
            }, "Timed out waiting for RBID to increment on " + curSecondary.host);
        } else {
            log(`Skipping RBID check on ${curSecondary.host} because shutdowns ` +
                `may prevent a rollback here.`);
        }

        // Ensure that the tiebreaker node is connected to the other nodes. We must do this after
        // we are sure that rollback has completed on the rollback node.
        tiebreakerNode.reconnect([curPrimary, curSecondary]);

        // Allow replication temporarily so the following checks succeed.
        restartServerReplication(tiebreakerNode);

        rst.awaitSecondaryNodes();
        rst.awaitReplication();

        log(`Rollback on ${curSecondary.host} (if needed) and awaitReplication completed`, true);

        // Unfreeze the node if it was previously frozen, so that it can run for the election.
        assert.commandWorked(curSecondary.adminCommand({replSetFreeze: 0}));

        // We call transition to steady state ops after awaiting replication has finished,
        // otherwise it could be confusing to see operations being replicated when we're already
        // in rollback complete state.
        transitionIfAllowed(State.kSteadyStateOps);

        // After the previous rollback (if any) has completed and await replication has finished,
        // the replica set should be in a consistent and "fresh" state. We now prepare for the next
        // rollback.
        if (skipDataConsistencyChecks) {
            print('Skipping data consistency checks');
        } else {
            checkDataConsistency();
        }

        // Now that awaitReplication and checkDataConsistency are done, stop replication again so
        // tiebreakerNode is never part of w: majority writes, see comment at top.
        stopServerReplication(tiebreakerNode);

        return curPrimary;
    };

    /**
     * Transition to the first stage of rollback testing, where we isolate the current primary so
     * that subsequent operations on it will eventually be rolled back.
     */
    this.transitionToRollbackOperations = function() {
        // Ensure previous operations are replicated to the secondary that will be used as the sync
        // source later on. It must be up-to-date to prevent any previous operations from being
        // rolled back.
        rst.awaitSecondaryNodes();
        rst.awaitReplication(null, null, [curSecondary]);

        transitionIfAllowed(State.kRollbackOps);

        // Disconnect the secondary from the tiebreaker node before we disconnect the secondary from
        // the primary to ensure that the secondary will be ineligible to win an election after it
        // loses contact with the primary.
        log(`Isolating the secondary ${curSecondary.host} from the tiebreaker
            ${tiebreakerNode.host}`);
        curSecondary.disconnect([tiebreakerNode]);

        // Disconnect the current primary, the rollback node, from the secondary so operations on
        // it will eventually be rolled back.
        // We do not disconnect the primary from the tiebreaker node so that it remains primary.
        log(`Isolating the primary ${curPrimary.host} from the secondary ${curSecondary.host}`);
        curPrimary.disconnect([curSecondary]);

        return curPrimary;
    };

    /**
     * Transition to the second stage of rollback testing, where we isolate the old primary and
     * elect the old secondary as the new primary. Then, operations can be performed on the new
     * primary so that that optimes diverge and previous operations on the old primary will be
     * rolled back.
     */
    this.transitionToSyncSourceOperationsBeforeRollback = function() {
        transitionIfAllowed(State.kSyncSourceOpsBeforeRollback);

        // Insert one document to ensure rollback will not be skipped.
        let dbName = "EnsureThereIsAtLeastOneOperationToRollback";
        assert.commandWorked(curPrimary.getDB(dbName).ensureRollback.insert(
            {thisDocument: 'is inserted to ensure rollback is not skipped'}));

        log(`Isolating the primary ${curPrimary.host} so it will step down`);
        // We should have already disconnected the primary from the secondary during the first stage
        // of rollback testing.
        curPrimary.disconnect([tiebreakerNode]);

        log(`Waiting for the primary ${curPrimary.host} to step down`);
        try {
            // The stepdown freeze period is short because the node is disconnected from
            // the rest of the replica set, so it physically can't become the primary.
            curPrimary.adminCommand({replSetStepDown: 1, force: true});
        } catch (e) {
            // Stepdown may fail if the node has already started stepping down.
            print('Caught exception from replSetStepDown: ' + e);
        }

        waitForState(curPrimary, ReplSetTest.State.SECONDARY);

        log(`Reconnecting the secondary ${curSecondary.host} to the tiebreaker node so it can be
            elected`);
        curSecondary.reconnect([tiebreakerNode]);

        log(`Waiting for the new primary ${curSecondary.host} to be elected`);
        assert.soonNoExcept(() => {
            const res = curSecondary.adminCommand({replSetStepUp: 1});
            return res.ok;
        });

        const newPrimary = rst.getPrimary();

        // As a sanity check, ensure the new primary is the old secondary. The opposite scenario
        // should never be possible with 2 electable nodes and the sequence of operations thus far.
        assert.eq(newPrimary, curSecondary, "Did not elect a new node as primary");
        log(`Elected the old secondary ${newPrimary.host} as the new primary`);

        // The old primary is the new secondary; the old secondary just got elected as the new
        // primary, so we update the topology to reflect this change.
        curSecondary = curPrimary;
        curPrimary = newPrimary;

        lastRBID = assert.commandWorked(curSecondary.adminCommand("replSetGetRBID")).rbid;

        // The current primary, which is the old secondary, will later become the sync source.
        return curPrimary;
    };

    /**
     * Transition to the third stage of rollback testing, where we reconnect the rollback node so
     * it will start rolling back.
     *
     * Note that there is no guarantee that operations performed on the sync source while in this
     * state will actually occur *during* the rollback process. They may happen before the rollback
     * is finished or after the rollback is done. We provide this state, though, as an attempt to
     * provide a way to test this behavior, even if it's non-deterministic.
     */
    this.transitionToSyncSourceOperationsDuringRollback = function() {
        transitionIfAllowed(State.kSyncSourceOpsDuringRollback);

        // If the rollback node was restarted, make sure it has finished restarting and become a
        // secondary again. Otherwise, the subsequent 'replSetFreeze' command could fail with
        // NotYetInitialized if the node is still in the process of restarting (e.g. not yet loaded
        // the local config or reached the STARTUP2 state).
        waitForState(curSecondary, ReplSetTest.State.SECONDARY);

        // If the nodes are restarted after the rollback node is able to rollback successfully and
        // catch up to curPrimary's oplog, then the rollback node can become the new primary.
        // If so, it can lead to unplanned state transitions, like unconditional step down, during
        // the test. To avoid those problems, prevent rollback node from starting an election.
        assert.commandWorked(curSecondary.adminCommand({replSetFreeze: ReplSetTest.kForeverSecs}));

        log(`Reconnecting the secondary ${curSecondary.host} so it'll go into rollback`);
        // Reconnect the rollback node to the current primary, which is the node we want to sync
        // from. If we reconnect to both the current primary and the tiebreaker node, the rollback
        // node may choose the tiebreaker.
        curSecondary.reconnect([curPrimary]);

        return curPrimary;
    };

    this.stop = function(checkDataConsistencyOptions) {
        restartServerReplication(tiebreakerNode);
        rst.awaitReplication();
        checkDataConsistency(checkDataConsistencyOptions);
        transitionIfAllowed(State.kStopped);
        return rst.stopSet();
    };

    this.getPrimary = function() {
        return curPrimary;
    };

    this.getSecondary = function() {
        return curSecondary;
    };

    this.restartNode = function(nodeId, signal, startOptions, allowedExitCode) {
        assert(signal === SIGKILL || signal === SIGTERM, `Received unknown signal: ${signal}`);
        assert.gte(nodeId, 0, "Invalid argument to RollbackTest.restartNode()");

        const hostName = rst.nodes[nodeId].host;

        if (!TestData.rollbackShutdowns) {
            log(`Not restarting node ${hostName} because 'rollbackShutdowns' was not specified.`);
            return;
        }

        if (nodeId >= kElectableNodes) {
            log(`Not restarting node ${nodeId} because this replica set is too small or because
                we don't want to restart the tiebreaker node.`);
            return;
        }

        if (!TestData.allowUncleanShutdowns && signal !== SIGTERM) {
            log(`Sending node ${hostName} signal ${SIGTERM}` +
                ` instead of ${signal} because 'allowUncleanShutdowns' was not specified.`);
            signal = SIGTERM;
        }

        // We may attempt to restart a node while it is in rollback or recovery, in which case
        // the validation checks will fail. We will still validate collections during the
        // RollbackTest's full consistency checks, so we do not lose much validation coverage.
        let opts = {skipValidation: true};

        if (allowedExitCode !== undefined) {
            Object.assign(opts, {allowedExitCode: allowedExitCode});
        } else if (signal === SIGKILL) {
            Object.assign(opts, {allowedExitCode: MongoRunner.EXIT_SIGKILL});
        }

        log(`Stopping node ${hostName} with signal ${signal}`);
        rst.stop(nodeId, signal, opts, {forRestart: true});
        log(`Restarting node ${hostName}`);
        rst.start(nodeId, startOptions, true /* restart */);

        // Freeze the node if the restarted node is the rollback node.
        if (curState === State.kSyncSourceOpsDuringRollback &&
            rst.getNodeId(curSecondary) === nodeId) {
            rst.freeze(nodeId);
        }

        const oldPrimary = curPrimary;
        // Wait for the new primary to be elected and ready to take operations before continuing.
        curPrimary = rst.getPrimary();

        // The primary can change after node restarts only if all the 3 nodes are connected to each
        // other.
        if (curState !== State.kSteadyStateOps) {
            assert.eq(curPrimary, oldPrimary);
        }

        curSecondary = rst.getSecondary();
        assert.neq(curPrimary, curSecondary);
    };

    /**
     * Waits for the last oplog entry to be visible on all nodes except the tiebreaker, which has
     * replication stopped throughout the test.
     */
    this.awaitLastOpCommitted = function(timeout) {
        return rst.awaitLastOpCommitted(timeout, [curPrimary, curSecondary]);
    };

    /**
     * Waits until the optime of the specified type reaches the primary's last applied optime.
     * Ignores the tiebreaker node, on which replication is stopped throughout the test.
     * See ReplSetTest for definition of secondaryOpTimeType.
     */
    this.awaitReplication = function(timeout, secondaryOpTimeType) {
        return rst.awaitReplication(timeout, secondaryOpTimeType, [curPrimary, curSecondary]);
    };

    /**
     * Returns the underlying ReplSetTest in case the user needs to make adjustments to it.
     */
    this.getTestFixture = function() {
        return rst;
    };
}
