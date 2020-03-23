// Tests that a change stream will correctly unwind applyOps entries generated by a transaction.
// @tags: [uses_transactions]

(function() {
"use strict";

load("jstests/libs/change_stream_util.js");        // For ChangeStreamTest.
load("jstests/libs/collection_drop_recreate.js");  // For assert[Drop|Create]Collection.

const otherCollName = "change_stream_apply_ops_2";
const coll = assertDropAndRecreateCollection(db, "change_stream_apply_ops");
assertDropAndRecreateCollection(db, otherCollName);

const otherDbName = "change_stream_apply_ops_db";
const otherDbCollName = "someColl";
assertDropAndRecreateCollection(db.getSiblingDB(otherDbName), otherDbCollName);

// Insert a document that gets deleted as part of the transaction.
const kDeletedDocumentId = 0;
coll.insert({_id: kDeletedDocumentId, a: "I was here before the transaction"},
            {writeConcern: {w: "majority"}});

let cst = new ChangeStreamTest(db);
let changeStream = cst.startWatchingChanges({
    pipeline: [{$changeStream: {}}, {$project: {"lsid.uid": 0}}],
    collection: coll,
    doNotModifyInPassthroughs:
        true  // A collection drop only invalidates single-collection change streams.
});

const sessionOptions = {
    causalConsistency: false
};
const session = db.getMongo().startSession(sessionOptions);
const sessionDb = session.getDatabase(db.getName());
const sessionColl = sessionDb[coll.getName()];

session.startTransaction({readConcern: {level: "snapshot"}, writeConcern: {w: "majority"}});
assert.commandWorked(sessionColl.insert({_id: 1, a: 0}));
assert.commandWorked(sessionColl.insert({_id: 2, a: 0}));

// One insert on a collection that we're not watching. This should be skipped by the
// single-collection changestream.
assert.commandWorked(sessionDb[otherCollName].insert({_id: 111, a: "Doc on other collection"}));

// One insert on a collection in a different database. This should be skipped by the single
// collection and single-db changestreams.
assert.commandWorked(
    session.getDatabase(otherDbName)[otherDbCollName].insert({_id: 222, a: "Doc on other DB"}));

assert.commandWorked(sessionColl.updateOne({_id: 1}, {$inc: {a: 1}}));

assert.commandWorked(sessionColl.deleteOne({_id: kDeletedDocumentId}));

assert.commandWorked(session.commitTransaction_forTesting());

// Do applyOps on the collection that we care about. This is an "external" applyOps, though
// (not run as part of a transaction) so its entries should be skipped in the change
// stream. This checks that applyOps that don't have an 'lsid' and 'txnNumber' field do not
// get unwound.
assert.commandWorked(db.runCommand({
    applyOps: [
        {op: "i", ns: coll.getFullName(), o: {_id: 3, a: "SHOULD NOT READ THIS"}},
    ]
}));

// Drop the collection. This will trigger an "invalidate" event at the end of the stream.
assert.commandWorked(db.runCommand({drop: coll.getName()}));

// Define the set of changes expected for the single-collection case per the operations above.
const expectedChanges = [
    {
        documentKey: {_id: 1},
        fullDocument: {_id: 1, a: 0},
        ns: {db: db.getName(), coll: coll.getName()},
        operationType: "insert",
        lsid: session.getSessionId(),
        txnNumber: session.getTxnNumber_forTesting(),
    },
    {
        documentKey: {_id: 2},
        fullDocument: {_id: 2, a: 0},
        ns: {db: db.getName(), coll: coll.getName()},
        operationType: "insert",
        lsid: session.getSessionId(),
        txnNumber: session.getTxnNumber_forTesting(),
    },
    {
        documentKey: {_id: 1},
        ns: {db: db.getName(), coll: coll.getName()},
        operationType: "update",
        updateDescription: {removedFields: [], updatedFields: {a: 1}},
        lsid: session.getSessionId(),
        txnNumber: session.getTxnNumber_forTesting(),
    },
    {
        documentKey: {_id: kDeletedDocumentId},
        ns: {db: db.getName(), coll: coll.getName()},
        operationType: "delete",
        lsid: session.getSessionId(),
        txnNumber: session.getTxnNumber_forTesting(),
    },
    {
        operationType: "drop",
        ns: {db: db.getName(), coll: coll.getName()},
    },
];

// Verify that the stream returns the expected sequence of changes.
const changes =
    cst.assertNextChangesEqual({cursor: changeStream, expectedChanges: expectedChanges});
// Single collection change stream should also be invalidated by the drop.
cst.assertNextChangesEqual({
    cursor: changeStream,
    expectedChanges: [{operationType: "invalidate"}],
    expectInvalidate: true
});

// Obtain the clusterTime from the first change.
const startTime = changes[0].clusterTime;

// Add an entry for the insert on db.otherColl into expectedChanges.
expectedChanges.splice(2, 0, {
    documentKey: {_id: 111},
    fullDocument: {_id: 111, a: "Doc on other collection"},
    ns: {db: db.getName(), coll: otherCollName},
    operationType: "insert",
    lsid: session.getSessionId(),
    txnNumber: session.getTxnNumber_forTesting(),
});

// Verify that a whole-db stream returns the expected sequence of changes, including the insert
// on the other collection but NOT the changes on the other DB or the manual applyOps.
changeStream = cst.startWatchingChanges({
    pipeline: [{$changeStream: {startAtOperationTime: startTime}}, {$project: {"lsid.uid": 0}}],
    collection: 1
});
cst.assertNextChangesEqual({cursor: changeStream, expectedChanges: expectedChanges});

// Add an entry for the insert on otherDb.otherDbColl into expectedChanges.
expectedChanges.splice(3, 0, {
    documentKey: {_id: 222},
    fullDocument: {_id: 222, a: "Doc on other DB"},
    ns: {db: otherDbName, coll: otherDbCollName},
    operationType: "insert",
    lsid: session.getSessionId(),
    txnNumber: session.getTxnNumber_forTesting(),
});

// Verify that a whole-cluster stream returns the expected sequence of changes, including the
// inserts on the other collection and the other database, but NOT the manual applyOps.
cst = new ChangeStreamTest(db.getSiblingDB("admin"));
changeStream = cst.startWatchingChanges({
    pipeline: [
        {$changeStream: {startAtOperationTime: startTime, allChangesForCluster: true}},
        {$project: {"lsid.uid": 0}}
    ],
    collection: 1
});
cst.assertNextChangesEqual({cursor: changeStream, expectedChanges: expectedChanges});

cst.cleanUp();
}());
