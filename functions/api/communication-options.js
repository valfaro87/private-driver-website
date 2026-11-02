import {json} from '../_lib/auth.js';
import {deliveryConfiguration} from '../_lib/communications.js';
export async function onRequestGet({env}){
 try{const c=await deliveryConfiguration(env);return json({emailAvailable:c.emailAvailable,smsAvailable:c.smsAvailable});}
 catch{return json({emailAvailable:false,smsAvailable:false});}
}
