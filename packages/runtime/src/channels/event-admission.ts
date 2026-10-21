// Owner-local durable admission and one-shot notification custody. Retain unknown
// notification attempts, never turn provider redelivery into a blind second send.
type Storage = Pick<DurableObjectStorage,'sql'|'transactionSync'>;
export const eventAdmission = (storage:Storage) => {
 const sql=storage.sql;
 sql.exec(`CREATE TABLE IF NOT EXISTS event_admissions (
   source TEXT NOT NULL, delivery TEXT NOT NULL, digest TEXT NOT NULL,
   body TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(source,delivery))`);
 return {
  admit(source:string,delivery:string,digest:string,body:string):'admitted'|'duplicate'|'conflict'|'capacity' {
   return storage.transactionSync(()=>{
    const prior=sql.exec<{digest:string}>('SELECT digest FROM event_admissions WHERE source=? AND delivery=?',source,delivery).toArray()[0];
    if(prior)return prior.digest===digest?'duplicate':'conflict';
    if(sql.exec<{n:number}>('SELECT count(*) AS n FROM event_admissions').one().n>=5000)return 'capacity';
    sql.exec("INSERT INTO event_admissions (source,delivery,digest,body,state) VALUES (?,?,?,?,'admitted')",source,delivery,digest,body);
    return 'admitted';
   });
  },
  claim(source:string,delivery:string):boolean {
   return sql.exec("UPDATE event_admissions SET state='unknown' WHERE source=? AND delivery=? AND state='admitted'",source,delivery).rowsWritten===1;
  },
  finish(source:string,delivery:string):void {
   sql.exec("UPDATE event_admissions SET state='completed' WHERE source=? AND delivery=? AND state='unknown'",source,delivery);
  },
  // The send was refused before it left the Worker. Still terminal: a redelivery must not notify later.
  undelivered(source:string,delivery:string):void {
   sql.exec("UPDATE event_admissions SET state='undelivered' WHERE source=? AND delivery=? AND state='unknown'",source,delivery);
  },
 };
};
