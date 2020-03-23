// Confirms the planCacheListPlans output format.
(function() {
"use strict";

const conn = MongoRunner.runMongod();
assert.neq(null, conn, "mongod was unable to start up");
const testDB = conn.getDB("jstests_plan_cache_list_plans_new_format");
const coll = testDB.test;
assert.commandWorked(
    testDB.adminCommand({setParameter: 1, internalQueryCacheListPlansNewOutput: true}));

assert.commandWorked(coll.createIndex({a: 1}));
assert.commandWorked(coll.createIndex({b: 1}));

const testQuery = {
    "a": {"$gte": 0},
    "b": 32
};
const testSort = {
    "c": -1
};
const testProjection = {};

// Validate planCacheListPlans result fields for a query shape with a corresponding cache entry.
assert.eq(0, coll.find(testQuery).sort(testSort).itcount());
let key = {query: testQuery, sort: testSort, projection: testProjection};
let res = assert.commandWorked(coll.runCommand('planCacheListPlans', key));

// Confirm both the existence and contents of "createdFromQuery".
assert(res.hasOwnProperty("createdFromQuery"),
       `planCacheListPlans should return a result with 
        field "createdFromQuery"`);
assert.eq(res.createdFromQuery.query,
          testQuery,
          `createdFromQuery should contain field "query"
        with value ${testQuery}, instead got "createdFromQuery": ${res.createdFromQuery}`);
assert.eq(res.createdFromQuery.sort,
          testSort,
          `createdFromQuery should contain field "sort"
        with value ${testSort}, instead got "createdFromQuery": ${res.createdFromQuery}`);
assert.eq(res.createdFromQuery.projection, testProjection, `createdFromQuery should contain 
        field "projection" with value ${testProjection}, instead got "createdFromQuery": 
        ${res.createdFromQuery}`);

// Confirm 'res' contains 'works' and a valid 'queryHash' field.
assert(res.hasOwnProperty("works"), `planCacheListPlans result is missing "works" field`);
assert.gt(res.works, 0, `planCacheListPlans result field "works" should be greater than 0`);
assert(res.hasOwnProperty("queryHash"),
       `planCacheListPlans result is missing "queryHash" 
        field`);
assert.eq(8,
          res.queryHash.length,
          `planCacheListPlans result field "queryHash" should be 8 
        characters long`);

// Validate that 'cachedPlan' and 'creationExecStats' fields exist and both have consistent
// information about the winning plan.
assert(res.hasOwnProperty("cachedPlan"),
       `planCacheListPlans result is missing field 
        "cachedPlan" field`);
assert(res.hasOwnProperty("creationExecStats"),
       `planCacheListPlans result is missing 
        "creationExecStats" field`);
assert.gte(res.creationExecStats.length,
           2,
           `creationExecStats should contain stats for both the
        winning plan and all rejected plans. Thus, should contain at least 2 elements but got:
        ${res.creationStats}`);
let cachedStage = assert(res.cachedPlan.stage, `cachedPlan should have field "stage"`);
let winningExecStage = assert(res.creationExecStats[0].executionStages,
                              `creationExecStats[0] 
        should have field "executionStages"`);
assert.eq(cachedStage,
          winningExecStage,
          `Information about the winning plan in "cachedPlan" is
        inconsistent with the first element in "creationExecStats".`);

// Ensures that the new format preservers information about the failed plans.
assert(coll.drop());

// Setup the database such that it will generate a failing plan and a succeeding plan.
const numDocs = 32;
const smallNumber = 10;
assert.commandWorked(testDB.adminCommand(
    {setParameter: 1, internalQueryMaxBlockingSortMemoryUsageBytes: smallNumber}));
for (let i = 0; i < numDocs * 2; ++i)
    assert.commandWorked(coll.insert({a: ((i >= (numDocs * 2) - smallNumber) ? 1 : 0), d: i}));

// Create the indexes to create competing plans.
assert.commandWorked(coll.createIndex({a: 1}));
assert.commandWorked(coll.createIndex({d: 1}));

// Assert that the find command found documents.
key = {
    query: {a: 1},
    sort: {d: 1},
    projection: {}
};
assert.eq(smallNumber, coll.find(key.query).sort(key.sort).itcount());
res = assert.commandWorked(coll.runCommand('planCacheListPlans', key));

// There should have been two plans generated.
assert.eq(res["creationExecStats"].length, 2);

// The second plan should have failed.
assert(res["creationExecStats"][1].failed);

// The failing plan should have a score of 0.
assert.eq(res["candidatePlanScores"][1], 0);
MongoRunner.stopMongod(conn);
})();
