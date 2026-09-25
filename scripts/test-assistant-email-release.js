const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const base=path.resolve(__dirname, '..');
const db={from(){throw Error('Unreleased endpoint touched storage');}};
function router(){const routes={};return {routes,get(p,h){routes['GET '+p]=h;},post(p,h){routes['POST '+p]=h;}};}
function response(){return {code:200,set(){return this;},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};}
test('unreleased email is unavailable and cannot create an account',async()=>{
 const app=router();require(path.join(base,'webapp/assistant-email-settings')).register(app,db,()=> 'owner');
 let res=response();await app.routes['GET /api/assistant-email']({},res);assert.deepEqual(res.body,{available:false});
 res=response();await app.routes['POST /api/assistant-email/enable']({},res);assert.equal(res.code,503);assert.match(res.body.error,/coming soon/);
});
