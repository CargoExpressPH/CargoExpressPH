import{A as R,u as le,a as ce,b as ue,M as J,N as de,O as pe,j as s,Q}from"./index-DD-3mtN6.js";import{r as l}from"./vendor-react-Dhj1h3vx.js";import{E as he}from"./EmptyState-viXZSFeI.js";import{c as me}from"./SkeletonLoader-BExugWC7.js";import{i as q,T as ge,R as ye,r as fe,ac as se,L as be,Y as ke,l as ve,b as xe,C as we}from"./vendor-icons-CGsYoI5g.js";import"./vendor-supabase-o79c1kQX.js";const _e=[/compla(int|in)/i,/damaged?/i,/refund/i,/lost\s*(package|shipment|parcel|item)/i,/missing\s*(package|shipment|item)/i,/(report|reimburse|reimbursement)/i,/urgent/i,/emergency/i,/supervisor/i,/manager/i,/talk\s*to\s*(admin|human|agent|person|staff|support)/i,/speak\s*to\s*(admin|human|agent|person|staff|support)/i,/connect\s*me\s*to/i,/real\s*(person|human|agent|admin)/i,/human\s*(agent|support|help)/i,/\bhuman\b/i,/\bagent\b/i],Se=[{id:"greeting",patterns:[/^(hi|hello|hey|good\s*(morning|afternoon|evening)|mabuhay|kumusta)/i],handler:async()=>({text:`Hi there! 👋 How can I help you today?

You can ask me about your:
• Shipment status
• Booking information
• Payment details
• Tracking number
• Delivery process`,askResolved:!1})},{id:"booking_status",patterns:[/active\s*booking/i,/my\s*(order|booking)/i,/do\s*i\s*have\s*(a|an)?\s*(order|booking)/i,/any\s*(order|booking)/i,/booking\s*status/i,/order\s*status/i],handler:async e=>{const a=await k(e);if(!a.length)return{text:`You currently don't have any active bookings.

Would you like to book a shipment? You can do so from the Book Shipment page.`,askResolved:!0};const t=a[0];return{text:`You have ${a.length} booking${a.length>1?"s":""}.

Your most recent booking:
📦 Tracking #: ${t.tracking_number}
📍 Status: ${t.status}
🚢 Route: ${t.origin} → ${t.destination}`,askResolved:!0}}},{id:"tracking_number",patterns:[/tracking\s*(number|#|num)/i,/what('?s|\s*is)\s*(my)?\s*tracking/i,/find\s*my\s*tracking/i],handler:async e=>{const a=await k(e);return a.length?{text:`Here are your tracking numbers:

${a.slice(0,3).map(o=>`• ${o.tracking_number} — ${o.status}`).join(`
`)}

You can use any of these on the Track Package page for full details.`,askResolved:!0}:{text:"You don't have any bookings yet, so there's no tracking number to show.",askResolved:!0}}},{id:"shipment_location",patterns:[/where\s*(is)?\s*(my|the)?\s*(package|shipment|parcel|cargo)/i,/status\s*of\s*my\s*(shipment|order|package)/i,/shipment\s*status/i,/package\s*status/i,/what\s*(is|'s)\s*(the)?\s*status/i,/update\s*on\s*my/i],handler:async e=>{const a=await k(e);if(!a.length)return{text:"You don't have any active bookings, so there's no shipment to track at the moment.",askResolved:!0};const t=a[0],o=Z[t.status]||`Your shipment status is: ${t.status}.`;return{text:`📦 Tracking: ${t.tracking_number}
📍 Status: **${t.status}**

${o}

🚢 Route: ${t.origin} → ${t.destination}${t.trips?`
🚚 Trip: ${t.trips.trip_number}`:""}`,askResolved:!0}}},{id:"pickup_status",patterns:[/already\s*picked\s*up/i,/has\s*(my|the)?\s*(package|shipment|order|parcel)\s*(been|already)?\s*picked/i,/pick\s*up\s*status/i,/when\s*(will|is)\s*(my)?\s*(package|shipment|order)?\s*(be|)?\s*picked/i],handler:async e=>{const a=await k(e);if(!a.length)return{text:"You don't have any bookings currently.",askResolved:!0};const t=a[0];return{text:["Picked Up","In Transit","Arrived at Hub","Out for Delivery","Delivered"].includes(t.status)?`✅ Yes! Your shipment (${t.tracking_number}) has already been picked up.

Current status: **${t.status}**`:`Your shipment (${t.tracking_number}) has not been picked up yet.

Current status: **${t.status}**

Our team will schedule the pickup soon.`,askResolved:!0}}},{id:"delivery_status",patterns:[/out\s*for\s*delivery/i,/already\s*delivered/i,/(is|has)\s*(my)?\s*(package|shipment|parcel|order)\s*(been|already)?\s*deliver/i,/when\s*(will|is)\s*(my)?\s*(package|shipment)?\s*(be)?\s*deliver/i,/deliver(y|ed|ing)/i],handler:async e=>{const a=await k(e);if(!a.length)return{text:"You don't have any bookings currently.",askResolved:!0};const t=a[0];return t.status==="Delivered"?{text:`✅ Your shipment (${t.tracking_number}) has been successfully delivered!`,askResolved:!0}:t.status==="Out for Delivery"?{text:`🚚 Your shipment (${t.tracking_number}) is currently **out for delivery**!

Our delivery personnel is on their way to deliver your package.`,askResolved:!0}:{text:`Your shipment (${t.tracking_number}) has not been delivered yet.

Current status: **${t.status}**

${Z[t.status]||""}`,askResolved:!0}}},{id:"hub_arrival",patterns:[/arrived?\s*(at)?\s*(the)?\s*hub/i,/hub\s*arrival/i,/(is|has)\s*(my)?\s*(package|shipment)?\s*(arrived?|reach)/i],handler:async e=>{const a=await k(e);if(!a.length)return{text:"You don't have any bookings currently.",askResolved:!0};const t=a[0];return{text:["Arrived at Hub","Out for Delivery","Delivered"].includes(t.status)?`✅ Yes! Your shipment (${t.tracking_number}) has arrived at the destination hub.

Current status: **${t.status}**`:`Your shipment (${t.tracking_number}) has not yet arrived at the hub.

Current status: **${t.status}**`,askResolved:!0}}},{id:"payment_info",patterns:[/how\s*much\s*(is|are|do)?\s*(my|the|i)?\s*(shipping|pay|fee|cost|balance|owe|owed)/i,/shipping\s*(fee|cost|rate|price)/i,/(payment|pay)\s*(status|info|information|detail)/i,/remaining\s*balance/i,/amount\s*(paid|due|owe)/i,/do\s*i\s*(still)?\s*(have|owe)\s*(a)?\s*(balance|remaining|unpaid)/i,/is\s*my\s*payment\s*(done|complete|full)/i,/paid\s*(already|in\s*full)?/i,/unpaid/i,/partial\s*payment/i],handler:async e=>{const a=await k(e);if(!a.length)return{text:"You don't have any bookings, so there's no payment information to show.",askResolved:!0};const t=a[0],o=parseFloat(t.shipping_cost||0),u=parseFloat(t.amount_paid||0),h=parseFloat(t.remaining_balance||0),m=t.payment_status;let f="";return m==="paid"?f="✅ Payment is **complete**. Thank you!":m==="partial"?f="⚠️ Partially paid. You still have a remaining balance.":f="❌ Payment is **unpaid**.",{text:`💰 Payment details for ${t.tracking_number}:

💵 Shipping Fee: ₱${o.toFixed(2)}
✅ Amount Paid: ₱${u.toFixed(2)}
🔴 Remaining Balance: ₱${h.toFixed(2)}

${f}`,askResolved:!0}}},{id:"trip_info",patterns:[/which\s*trip/i,/assigned\s*to\s*(a|which|what)?\s*trip/i,/trip\s*(number|#|num|detail|info|assign)/i,/what\s*trip/i,/has\s*(my)?\s*(trip|shipment)\s*(started|depart)/i,/trip\s*start/i],handler:async e=>{const a=await k(e);if(!a.length)return{text:"You don't have any bookings currently.",askResolved:!0};const t=a[0];if(!t.trips)return{text:`Your shipment (${t.tracking_number}) has not been assigned to a trip yet.

Current status: **${t.status}**

Our admin will assign it to an upcoming trip soon.`,askResolved:!0};const o=t.trips,u=o.status==="in_progress"?"🚢 Trip is currently **underway**.":o.status==="completed"?"✅ Trip has **arrived** at the destination.":`📅 Trip is **${o.status}**.`;return{text:`🚢 Your shipment (${t.tracking_number}) is on:

📋 Trip: ${o.trip_number}
🗺️ Route: ${o.origin} → ${o.destination}
${u}`,askResolved:!0}}},{id:"how_to_book",patterns:[/how\s*(to|do\s*i|can\s*i)\s*(book|place|create|make)\s*(a|an)?\s*(shipment|order|booking|cargo)/i,/how\s*does?\s*(booking|shipment)\s*work/i,/process\s*(of|for)\s*(booking|shipping)/i],handler:async()=>({text:`📦 To book a shipment with CargoExpress PH:

1️⃣ Go to the **Book Shipment** page from your dashboard
2️⃣ Fill in sender & receiver details
3️⃣ Enter package weight and description
4️⃣ Choose a route (Bohol → Manila or Manila → Bohol)
5️⃣ Select a trip (optional) or let admin assign one
6️⃣ Submit your booking

Payment is collected upon pickup.`,askResolved:!0})},{id:"delivery_timeline",patterns:[/how\s*long\s*(does?|will)\s*(it\s*take|the\s*(delivery|shipping))/i,/when\s*will\s*(it|my\s*(package|shipment))\s*(arrive|be\s*delivered)/i,/eta/i,/delivery\s*time/i,/how\s*many\s*days/i],handler:async()=>({text:`⏱️ Delivery Timeline:

• **Bohol → Manila**: Approximately 3–5 business days
• **Manila → Bohol**: Approximately 3–5 business days

Actual delivery time may vary depending on trip schedules and weather conditions at sea.`,askResolved:!0})},{id:"pricing",patterns:[/(how\s*much|what'?s?\s*the\s*(price|rate|cost))\s*(per\s*kilo|per\s*kg)?/i,/rate\s*(per\s*kilo|per\s*kg)/i,/price\s*(list|per\s*kilo|per\s*kg)/i,/how\s*much\s*(would|does?)\s*(it|shipping)\s*cost/i],handler:async()=>{let e=70;try{const{data:a}=await R.from("company_information").select("default_price_per_kg").single();a!=null&&a.default_price_per_kg&&(e=parseFloat(a.default_price_per_kg))}catch{}return{text:`💰 Our current shipping rate is ₱${e.toFixed(2)} per kilogram.

For example:
• 5 kg = ₱${(5*e).toFixed(2)}
• 10 kg = ₱${(10*e).toFixed(2)}
• 20 kg = ₱${(20*e).toFixed(2)}

Payment is made upon pickup.`,askResolved:!0}}},{id:"contact_info",patterns:[/contact\s*(number|info|information|us|admin|support)/i,/phone\s*number/i,/facebook|fb\s*(page)?/i,/how\s*(can\s*i|to)\s*contact/i,/email\s*(address|contact)?/i],handler:async()=>{let e=null;try{const{data:t}=await R.from("company_information").select("smart_phone, globe_phone, facebook, email").single();e=t}catch{}const a=[];return e!=null&&e.smart_phone&&a.push(`📱 Smart: ${e.smart_phone}`),e!=null&&e.globe_phone&&a.push(`📱 Globe: ${e.globe_phone}`),e!=null&&e.facebook&&a.push(`📘 Facebook: ${e.facebook}`),e!=null&&e.email&&a.push(`📧 Email: ${e.email}`),{text:a.length?`Here are our contact details:

${a.join(`
`)}

You can also message us through the About Us page.`:"Please visit our About Us page for contact information.",askResolved:!0}}},{id:"thanks",patterns:[/^(thank(s|\s*you)|ty|salamat|ok\s*thanks?|great\s*thanks?|okay\s*thanks?)/i,/^(bye|goodbye|take\s*care)/i],handler:async()=>({text:"You're welcome! 😊 Have a great day! If you need anything else, feel free to message us anytime.",askResolved:!1})}],Z={Pending:"Your booking has been received and is awaiting review by our administrator.",Assigned:"Your shipment has been assigned to a scheduled trip and is waiting for pickup.","Picked Up":"Your shipment has been collected and is being prepared for transport.","In Transit":"Your shipment is currently traveling toward the destination.","Arrived at Hub":"Your shipment has arrived at the destination hub and is being organized for delivery.","Out for Delivery":"Our delivery personnel is currently delivering your shipment.",Delivered:"Your shipment has been successfully delivered.",Cancelled:"This shipment has been cancelled."},k=async e=>{const{data:a,error:t}=await R.from("orders").select(`
      id, tracking_number, status, origin, destination,
      shipping_cost, amount_paid, remaining_balance, payment_status,
      package_weight, actual_weight, sender_name, receiver_name,
      created_at,
      trips:trip_id (trip_number, origin, destination, status)
    `).eq("user_id",e).neq("status","Cancelled").order("created_at",{ascending:!1}).limit(5);if(t)throw t;return a||[]},Re=async(e,a)=>{const t=e.trim();if(_e.some(o=>o.test(t)))return{text:null,escalate:!0,askResolved:!1};for(const o of Se)if(o.patterns.some(u=>u.test(t)))try{return{escalate:!1,...await o.handler(a)}}catch(u){console.warn("[Bot] Intent handler error:",u.message)}return{text:`I'm sorry, I didn't quite understand that. 🤔

I can help you with:
• Shipment status & location
• Tracking number
• Payment details
• Booking information
• Delivery timeline
• Pricing & rates

You can also select **❌ No** to connect with one of our support agents.`,escalate:!1,askResolved:!0}},ee=`Hello! 👋 Welcome to CargoExpress PH Support.

I'm your virtual assistant. I can help you with:

• Shipment status & location
• Booking information
• Payment details & balance
• Tracking numbers
• Delivery process & timeline
• Frequently asked questions

How can I help you today?`,je=15e3,Te=1e3,A=48,te=`Welcome back! 👋

I'm CargoExpress Assistant.

How can I help you today?`,$e=e=>{const a=(e==null?void 0:e.message)||String(e||"");return a.includes("PGRST116")||a.includes("0 rows")?"Could not find or create your chat conversation. Please try again.":a.includes("JWT")||a.toLowerCase().includes("unauthorized")?"Your session has expired. Please refresh the page and log in again.":a.toLowerCase().includes("network")||a.toLowerCase().includes("failed to fetch")?"Network error. Please check your internet connection and try again.":a.toLowerCase().includes("timeout")||a.includes("AbortError")?"The request timed out. Please try again.":a||"Failed to load chat. Please try again."},ae=e=>e?new Date(e).toLocaleTimeString("en-PH",{hour:"numeric",minute:"2-digit",hour12:!0}):"",Ne=({m:e,showResolutionPrompt:a,onVoteYes:t,onVoteNo:o,adminName:u})=>{var d;const h=e.sender_role==="customer",m=e.sender_role==="bot",f=h?{background:"var(--primary)",color:"white",borderRadius:"18px 18px 4px 18px"}:m?{background:"var(--bg-secondary)",color:"var(--text)",borderRadius:"18px 18px 18px 4px",border:"1px solid var(--border-light)"}:{background:"var(--surface)",color:"var(--text)",borderRadius:"18px 18px 18px 4px",border:"1px solid var(--border-light)"},v=((d=e.profiles)==null?void 0:d.name)||u||"Support Agent";return s.jsxs("div",{className:`support-message-row ${h?"is-me":"is-admin"}`,children:[!h&&s.jsx("div",{className:`chat-avatar ${m?"bot-avatar":"admin-avatar"}`,children:m?s.jsx(se,{size:12}):s.jsx(ve,{size:12})}),s.jsxs("div",{className:"support-message-stack",children:[m&&s.jsx("div",{className:"chat-sender-label bot-label",children:"🤖 CargoExpress Assistant"}),e.sender_role==="admin"&&s.jsxs("div",{className:"chat-sender-label admin-label",children:["👤 ",v]}),s.jsx("div",{className:"support-message-bubble",style:f,children:e.message.split(`
`).map((j,x,E)=>s.jsxs("span",{children:[j,x<E.length-1&&s.jsx("br",{})]},x))}),s.jsx("div",{className:`chat-timestamp ${h?"text-right":""}`,children:ae(e.created_at)}),m&&a&&s.jsxs("div",{className:"chat-resolution-prompt",children:[s.jsx("span",{className:"chat-resolution-text",children:"Did I solve your concern?"}),s.jsxs("div",{className:"chat-resolution-btns",children:[s.jsxs("button",{className:"chat-resolve-btn yes",onClick:t,children:[s.jsx(xe,{size:14})," Yes"]}),s.jsxs("button",{className:"chat-resolve-btn no",onClick:o,children:[s.jsx(we,{size:14})," No"]})]})]})]})]})},He=()=>{le("Support Chat");const{user:e}=ce(),a=ue(),[t,o]=l.useState(null),[u,h]=l.useState("closed"),[m,f]=l.useState(null),[v,d]=l.useState([]),[j,x]=l.useState(""),[E,N]=l.useState(!0),[G,M]=l.useState(null),[C,P]=l.useState(!1),[b,I]=l.useState(!1),[Ce,B]=l.useState(48),[H,w]=l.useState(!1),[ne,_]=l.useState(null),U=l.useRef(null),D=l.useRef(null),Y=l.useRef(null),g=l.useRef(!0),T=l.useRef(null),$=l.useCallback(()=>{Y.current&&(clearTimeout(Y.current),Y.current=null)},[]),S=l.useCallback(async(n,i)=>{if(!(e!=null&&e.id)||!i)return null;try{return await J(i,e.id,"bot",n)}catch(r){return console.warn("[Bot] insertBotMessage failed:",r.message),null}},[e==null?void 0:e.id]),W=l.useRef(!1),K=l.useCallback(async()=>{var n;if(e!=null&&e.id){M(null),N(!0),o(null),d([]),_(null),w(!1),$(),Y.current=setTimeout(()=>{g.current&&(N(!1),M("Loading took too long. Please check your connection and try again."))},je);try{const i=await de(e.id),r=await pe(i.id);if($(),!g.current)return;const c=i.status||"open";if(o(i.id),h(c),(n=i.assigned_admin)!=null&&n.name&&f(i.assigned_admin.name),c==="closed"){w(!0);const p=r&&r.length>0,y=p?r[r.length-1]:null,O=y&&(y.message===ee||y.message===te);if(d(r||[]),!O&&!W.current){W.current=!0;const F=await S(p?te:ee,i.id);F&&g.current&&d(z=>z.some(oe=>oe.id===F.id)?z:[...z,F])}}else w(!1),d(r||[]);N(!1)}catch(i){if($(),g.current){const r=$e(i);M(r),N(!1),a.error(r)}}}},[e==null?void 0:e.id,$,a,S]);l.useEffect(()=>(g.current=!0,e!=null&&e.id&&K(),()=>{g.current=!1,$()}),[e==null?void 0:e.id]),l.useEffect(()=>{if(!t)return;T.current&&(R.removeChannel(T.current),T.current=null);const n=R.channel(`chat_hybrid_${t}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"chat_messages",filter:`conversation_id=eq.${t}`},i=>{g.current&&d(r=>r.some(c=>c.id===i.new.id)?r:[...r,i.new])}).on("postgres_changes",{event:"UPDATE",schema:"public",table:"conversations",filter:`id=eq.${t}`},i=>{if(!g.current)return;const r=i.new.status||"open";h(r),(r==="open"||r==="waiting_admin")&&(w(!1),_(null))}).subscribe();return T.current=n,()=>{R.removeChannel(n),T.current=null}},[t]),l.useEffect(()=>{var n;(n=U.current)==null||n.scrollIntoView({behavior:"smooth"})},[v,b]);const V=async()=>{const n=j.trim();if(!(!n||!t||!e||C||b)){x(""),D.current&&(D.current.style.height="auto"),B(48),_(null),P(!0);try{const i=await J(t,e.id,"customer",n);if(d(c=>c.some(p=>p.id===i.id)?c:[...c,i]),!H){P(!1);return}I(!0),P(!1);const r=await Re(n,e.id);if(await new Promise(c=>setTimeout(c,700+Math.random()*400)),!g.current)return;if(I(!1),r.escalate){const p=await S(`I understand you need more specific assistance.

Please wait while I connect you with one of our support administrators. 🔄`,t);p&&d(y=>y.some(O=>O.id===p.id)?y:[...y,p]),await Q(t),h("waiting_admin"),w(!1)}else{const c=await S(r.text,t);c&&g.current&&(d(p=>p.some(y=>y.id===c.id)?p:[...p,c]),r.askResolved&&_(c.id))}}catch{P(!1),I(!1),a.error("Failed to send message. Please try again."),x(n)}}},ie=async()=>{_(null);const n=await S(`Thank you for contacting CargoExpress PH! 😊

Have a great day! If you have another concern in the future, feel free to message us anytime.`,t);n&&d(i=>i.some(r=>r.id===n.id)?i:[...i,n])},re=async()=>{_(null);const n=await S(`Thank you. I wasn't able to fully resolve your concern. 🙏

Please wait while one of our administrators assists you.`,t);n&&d(i=>i.some(r=>r.id===n.id)?i:[...i,n]);try{await Q(t),h("waiting_admin"),w(!1)}catch{a.error("Failed to connect to admin. Please try again.")}};if(E)return s.jsxs("div",{className:"page-transition support-chat-page",role:"status","aria-live":"polite","aria-busy":"true",children:[s.jsx("span",{className:"sr-only",children:"Loading support chat..."}),s.jsx(me,{})]});if(G)return s.jsxs("div",{className:"page-transition support-chat-page",children:[s.jsxs("div",{className:"mb-16",children:[s.jsxs("h2",{className:"fw-800 mb-4 flex items-center gap-8",children:[s.jsx(q,{size:22,color:"var(--primary)"}),"Support Chat"]}),s.jsx("p",{className:"text-secondary text-sm",children:"Message our support team for help with your shipments."})]}),s.jsxs("div",{className:"card animate-scale-in text-center",role:"alert",style:{padding:40},children:[s.jsx("div",{className:"flex items-center justify-center mx-auto mb-16",style:{width:56,height:56,borderRadius:"50%",background:"var(--error-bg)"},children:s.jsx(ge,{size:28,color:"var(--error)","aria-hidden":"true"})}),s.jsx("h3",{className:"mb-8",style:{color:"var(--error-dark)"},children:"Unable to Load Chat"}),s.jsx("p",{className:"text-secondary text-sm mb-20",children:G}),s.jsxs("button",{className:"btn btn-primary flex items-center gap-8 mx-auto",onClick:K,children:[s.jsx(ye,{size:16})," Try Again"]})]})]});const X=u==="waiting_admin",L=C||b;return s.jsxs("div",{className:"support-chat-page page-transition",children:[s.jsxs("div",{className:"mb-16",children:[s.jsxs("h2",{className:"fw-800 mb-4 flex items-center gap-8",children:[s.jsx(q,{size:22,color:"var(--primary)"}),"Support Chat"]}),s.jsx("p",{className:"text-secondary text-sm",children:H?"Our virtual assistant is ready to help you 24/7.":"You are connected to our support team."})]}),X&&s.jsxs("div",{className:"chat-waiting-banner",role:"status",children:[s.jsx(fe,{size:16}),s.jsx("span",{children:"Connecting you to a support agent. You can keep adding details here while you wait."})]}),s.jsxs("div",{className:"support-chat-messages",role:"log","aria-live":"polite","aria-label":"Support chat messages",children:[v.length===0&&!b&&s.jsx(he,{icon:q,title:"No Messages Yet",description:"Send a message to start chatting with our support team!"}),v.map((n,i)=>{const r=i===0||v[i-1]&&new Date(n.created_at)-new Date(v[i-1].created_at)>3e5,c=n.sender_role==="bot"&&n.id===ne;return s.jsxs("div",{children:[r&&s.jsxs("div",{className:"text-center mt-12 mb-8 text-tertiary fw-600",style:{fontSize:"0.6875rem"},children:[new Date(n.created_at).toLocaleDateString("en-PH",{month:"short",day:"numeric"})," · ",ae(n.created_at)]}),s.jsx(Ne,{m:n,showResolutionPrompt:c,onVoteYes:ie,onVoteNo:re,adminName:m})]},n.id)}),b&&s.jsxs("div",{className:"support-message-row is-admin",role:"status","aria-label":"Assistant is typing",children:[s.jsx("div",{className:"chat-avatar bot-avatar",children:s.jsx(se,{size:12})}),s.jsxs("div",{className:"support-message-stack",children:[s.jsx("div",{className:"chat-sender-label bot-label",children:"🤖 CargoExpress Assistant"}),s.jsxs("div",{className:"chat-typing-dots",children:[s.jsx("span",{}),s.jsx("span",{}),s.jsx("span",{})]})]})]}),s.jsx("div",{ref:U})]}),s.jsxs("div",{className:"flex gap-8 items-end",style:{borderRadius:24},children:[s.jsx("textarea",{ref:D,className:"form-input flex-1",placeholder:X?"Leave more details for the support agent...":b?"Assistant is typing…":H?"Ask me anything about your shipment…":"Type your message…","aria-label":"Type your support message",maxLength:Te,value:j,onChange:n=>{const i=n.target.value;if(x(i),!i.trim()){n.target.style.height=`${A}px`,B(A);return}n.target.style.height=`${A}px`;const r=Math.min(Math.max(n.target.scrollHeight,A),120);n.target.style.height=`${r}px`,B(r)},onKeyDown:n=>{n.key==="Enter"&&!n.shiftKey&&(n.preventDefault(),V())},style:{borderRadius:18,paddingLeft:18,paddingRight:18,paddingTop:12,paddingBottom:12,resize:"none",minHeight:"48px",maxHeight:"120px",lineHeight:"1.4",overflowY:"auto",opacity:L?.6:1},rows:1,disabled:L}),s.jsx("button",{className:"chat-send-btn",type:"button",onClick:V,disabled:!j.trim()||L,"aria-label":C||b?"Sending…":"Send message",style:{width:44,height:44,marginBottom:2},children:C||b?s.jsx(be,{size:18,className:"animate-spin"}):s.jsx(ke,{size:18})})]})]})};export{He as default};
