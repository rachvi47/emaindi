import {auth,db,onAuthStateChanged,signInWithEmailAndPassword,createUserWithEmailAndPassword,updateProfile,GoogleAuthProvider,signInWithPopup,RecaptchaVerifier,signInWithPhoneNumber,doc,setDoc,serverTimestamp} from "../fire.js";
const $=id=>document.getElementById(id);
let mode="login",confirmation=null,verifier=null,busy=false;
function message(text,ok=false){$("auth-message").textContent=text;$("auth-message").style.color=ok?"#16856b":""}
function render(){const signup=mode==="signup";$("tab-login").classList.toggle("active",!signup);$("tab-signup").classList.toggle("active",signup);$("name-field").hidden=!signup;$("email-submit").textContent=signup?"Create account":"Sign in";$("password").autocomplete=signup?"new-password":"current-password"}
async function ensureProfile(user,name=""){const ref=doc(db,"users",user.uid);const data={uid:user.uid,email:user.email||"",phone:user.phoneNumber||"",photoUrl:user.photoURL||"",updatedAt:serverTimestamp()};if(name)data.name=name;if(user.displayName&&!name)data.name=user.displayName;await setDoc(ref,data,{merge:true})}
async function done(user,name=""){await ensureProfile(user,name);location.replace("./index.html")}
onAuthStateChanged(auth,user=>{if(user&&!busy)location.replace("./index.html")});
$("tab-login").addEventListener("click",()=>{mode="login";message("");render()});
$("tab-signup").addEventListener("click",()=>{mode="signup";message("");render()});
$("email-form").addEventListener("submit",async e=>{
 e.preventDefault();if(busy)return;busy=true;const button=$("email-submit");button.disabled=true;message("");
 try{const email=$("email").value.trim().toLowerCase(),password=$("password").value;let result;if(mode==="signup"){const name=$("name").value.trim();if(!name)throw new Error("Enter your name.");result=await createUserWithEmailAndPassword(auth,email,password);await updateProfile(result.user,{displayName:name});await done(result.user,name)}else{result=await signInWithEmailAndPassword(auth,email,password);await done(result.user)}}
 catch(err){message(err.code==="auth/invalid-credential"?"Email or password is incorrect.":err.code==="auth/email-already-in-use"?"This email already has an account. Sign in instead.":err.code==="auth/weak-password"?"Use a password with at least 6 characters.":err.code==="auth/operation-not-allowed"?"Email sign-in is disabled in Firebase Authentication.":err.message||"Sign in failed.")}
 finally{busy=false;button.disabled=false}
});
$("google").addEventListener("click",async()=>{if(busy)return;busy=true;message("");try{const result=await signInWithPopup(auth,new GoogleAuthProvider());await done(result.user)}catch(err){message(err.code==="auth/popup-closed-by-user"?"The Google sign-in window was closed.":err.message||"Google sign-in failed.")}finally{busy=false}});
async function getVerifier(){if(verifier)return verifier;verifier=new RecaptchaVerifier(auth,"recaptcha-container",{size:"invisible"});await verifier.render();return verifier}
$("phone-form").addEventListener("submit",async e=>{
 e.preventDefault();if(busy)return;busy=true;const button=$("phone-submit");button.disabled=true;message("");
 try{
  if(!confirmation){const phone=$("phone").value.trim();if(!/^\+[1-9]\d{7,14}$/.test(phone))throw new Error("Enter the full phone number with country code, for example +919876543210.");confirmation=await signInWithPhoneNumber(auth,phone,await getVerifier());$("code-field").hidden=false;button.textContent="Verify and continue";message("Verification code sent. Check your SMS.",true)}
  else{const result=await confirmation.confirm($("code").value.trim());await done(result.user)}
 }catch(err){message(err.code==="auth/invalid-verification-code"?"That verification code is incorrect.":err.code==="auth/too-many-requests"?"Too many attempts. Please wait and try again.":err.message||"Phone verification failed.");if(err.code&&err.code.startsWith("auth/")){try{verifier?.clear()}catch(_){}verifier=null;confirmation=null;$("code-field").hidden=true;button.textContent="Send verification code"}}
 finally{busy=false;button.disabled=false}
});
render();
