// Deterministic WebView/Back proof. Preview transport is a fixture; full-image acceptance is native.
function installFixture() {
  return (async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const context = canvas.getContext("2d");
    context.fillStyle = "#203d4a";
    context.fillRect(0, 0, 640, 480);
    context.fillStyle = "#b99860";
    context.fillRect(60, 70, 240, 300);
    const full = await (await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))).arrayBuffer();
    const thumb = document.createElement("canvas");
    thumb.width = 64;
    thumb.height = 48;
    thumb.getContext("2d").drawImage(canvas, 0, 0, 64, 48);
    const jpeg = await (await new Promise((resolve) => thumb.toBlob(resolve, "image/jpeg"))).arrayBuffer();
    const nativePost = window.ipc.postMessage.bind(window.ipc);
    const fixture = { calls: [], evidence: {}, active: 0, maximum: 0, resolves: 0, native: false };
    window.__nearbySmoke = fixture;
    const resolveFixture = async (command, args) => {
      fixture.calls.push({ command, args });
      if (["get_random_frame", "get_frame_by_id"].includes(command)) {
        const id = args.id ?? "abc123";
        return { source: "prntsc", id, sourcePageUrl: `https://prnt.sc/${id}`, mimeType: "image/png" };
      }
      if (command === "get_frame_image") return full.slice(0);
      if (command === "resolve_nearby_frame") {
        fixture.resolves++;
        fixture.active++;
        fixture.maximum = Math.max(fixture.maximum, fixture.active);
        await new Promise((resolve) => setTimeout(resolve, 80));
        fixture.active--;
        if (["abc122", "abc127"].includes(args.id) && !args.retry)
          return { state: "retryable", kind: "timeout", message: "The source timed out" };
        if (args.id === "abc126") {
          fixture.evidence[args.id] = 2;
          return { state: "unavailable", reason: "Unavailable" };
        }
        fixture.evidence[args.id] = 1;
        return {
          state: "available",
          source: "prntsc",
          id: args.id,
          sourcePageUrl: `https://prnt.sc/${args.id}`,
          thumbnailHandle: args.id,
        };
      }
      if (command === "get_nearby_thumbnail") return jpeg.slice(0);
      throw new Error(`Unexpected fixture command ${command}`);
    };
    const intercept = (serialized) => {
      if (fixture.native) return nativePost(serialized);
      const message = JSON.parse(serialized);
      if (message.cmd === "set_nearby_window") {
        const callback = window.__TAURI_INTERNALS__.transformCallback((result) => {
          window.__TAURI_INTERNALS__.unregisterCallback(error);
          window.__TAURI_INTERNALS__.runCallback(message.callback, {
            ...result,
            evidence: { ...result.evidence, ...fixture.evidence },
          });
        }, true);
        const error = window.__TAURI_INTERNALS__.transformCallback((failure) => {
          window.__TAURI_INTERNALS__.unregisterCallback(callback);
          window.__TAURI_INTERNALS__.runCallback(message.error, failure);
        }, true);
        nativePost(JSON.stringify({ ...message, callback, error }));
      } else if (
        [
          "get_random_frame",
          "get_frame_by_id",
          "get_frame_image",
          "resolve_nearby_frame",
          "get_nearby_thumbnail",
        ].includes(message.cmd)
      ) {
        void resolveFixture(message.cmd, message.payload).then(
          (result) => window.__TAURI_INTERNALS__.runCallback(message.callback, result),
          (failure) => window.__TAURI_INTERNALS__.runCallback(message.error, String(failure)),
        );
      } else nativePost(serialized);
    };
    // Android injects a Java method that ignores assignment; replace the writable bridge object.
    window.ipc = { postMessage: intercept };
    if (window.ipc.postMessage !== intercept) throw new Error("Debug IPC fixture could not be installed");
    document.querySelector("#draw-button").click();
    for (let i = 0; i < 80 && document.querySelector("#nearby-button").disabled; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    return (
      !document.querySelector("#nearby-button").disabled &&
      fixture.calls.some((call) => call.command === "get_random_frame") &&
      document.querySelector("#image-id-value").textContent.includes("abc123")
    );
  })();
}

export async function runNearbySmoke({ adb, evaluate, check, sleep }) {
  check(await evaluate(`(${installFixture.toString()})()`), "Nearby fixture full image is displayed");
  const before = await evaluate(
    `Promise.all(['get_history','get_viewing_activity'].map(c=>window.__TAURI_INTERNALS__.invoke(c)))`,
  );
  check(
    await evaluate(
      `(() => {document.querySelector('#nearby-button').click();const tile=document.querySelector('[aria-current="true"]');return document.querySelector('#nearby-dialog').open && tile?.querySelector('img').src===document.querySelector('#image').src;})()`,
    ),
    "Nearby shows Current before preview completion",
  );
  await sleep(1200);
  check(
    await evaluate(
      `window.__nearbySmoke.maximum===2 && window.__nearbySmoke.resolves===9 && document.querySelector('#nearby-grid').children.length===9`,
    ),
    "Nearby starts nine fixture checks with two resolves maximum",
  );
  check(
    await evaluate(
      `(() => {const d=document.querySelector('#nearby-dialog'), f=d.querySelector('footer').getBoundingClientRect();return f.bottom<=innerHeight+1 && [...d.querySelectorAll('.nearby-navigation button,.history-close,#nearby-retry')].filter(x=>!x.hidden).every(x=>x.getBoundingClientRect().height>=48) && document.body.scrollHeight<=innerHeight+1;})()`,
    ),
    "Android Nearby keeps controls visible, 48px targets and no document scroll",
  );
  await evaluate(`document.querySelector('#nearby-next').click();true`);
  await sleep(1000);
  check(
    await evaluate(
      `document.querySelector('#nearby-center').textContent==='abc127' && document.querySelector('#nearby-grid').children[0].querySelector('[aria-current="true"]')!==null && window.__nearbySmoke.resolves===13`,
    ),
    "Next 4 retains Current and introduces exactly four fixture checks",
  );
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await sleep(1000);
  check(
    await evaluate(
      `!document.querySelector('#nearby-dialog').open && document.activeElement===document.querySelector('#nearby-button')`,
    ),
    "system Back dismisses Nearby and restores Nearby button focus",
  );
  check(
    JSON.stringify(
      await evaluate(
        `Promise.all(['get_history','get_viewing_activity'].map(c=>window.__TAURI_INTERNALS__.invoke(c)))`,
      ),
    ) === JSON.stringify(before),
    "Nearby fixture inspection and Back preserve native History and Activity",
  );
  await evaluate(`document.querySelector('#nearby-button').click();true`);
  await sleep(400);
  await evaluate(`document.querySelector('[aria-current="true"]').click();true`);
  await sleep(400);
  check(
    JSON.stringify(
      await evaluate(
        `Promise.all(['get_history','get_viewing_activity'].map(c=>window.__TAURI_INTERNALS__.invoke(c)))`,
      ),
    ) === JSON.stringify(before),
    "activating Current makes no native persistence changes",
  );
  await evaluate(`document.querySelector('#nearby-button').click();true`);
  await sleep(400);
  await evaluate(`document.querySelector('[aria-label="Open Prnt.sc frame abc124"]').click();true`);
  await sleep(1200);
  const after = await evaluate(
    `Promise.all(['get_history','get_viewing_activity'].map(c=>window.__TAURI_INTERNALS__.invoke(c)))`,
  );
  check(
    after[0].history.length === before[0].history.length + 1 && after[1].viewedTotal === before[1].viewedTotal,
    "Nearby full-image acceptance adds native History with zero Draw activity",
  );
  check(
    await evaluate(
      `document.querySelector('#image').naturalWidth===640 && window.__nearbySmoke.calls.filter(x=>['get_frame_by_id','get_frame_image'].includes(x.command)&&x.args.id==='abc124').every(x=>x.args.intent==='nearby')`,
    ),
    "Nearby selection uses full bytes and explicit intent on both loader stages",
  );
  await runResourceChecks({ adb, evaluate, check, sleep });
}

async function runResourceChecks({ adb, evaluate, check, sleep }) {
  check(
    await evaluate(`(async () => {
    const live=new Set(), create=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=(blob)=>{const url=create(blob);live.add(url);return url;};
    URL.revokeObjectURL=(url)=>{live.delete(url);revoke(url);};
    for(let i=0;i<12;i++){
      document.querySelector('#nearby-button').click();
      await new Promise(r=>setTimeout(r,100));document.querySelector('#nearby-close').click();
      await new Promise(r=>setTimeout(r,220));
    }
    URL.createObjectURL=create;URL.revokeObjectURL=revoke;
    return live.size===0 && !document.querySelector('#nearby-dialog').open && document.querySelectorAll('.nearby-tile').length===0;
  })()`),
    "twelve Android open/close cycles release gallery URLs and image nodes",
  );
  const memory = () =>
    adb("shell", "dumpsys", "meminfo", "dev.randomframe.android.debug")
      .split("\n")
      .find((line) => line.includes("TOTAL PSS:"))
      ?.trim();
  const samples = [memory()];
  check(
    await evaluate(`(async () => {
    window.__nearbySmoke.native=true;
    const invoke=window.__TAURI_INTERNALS__.invoke;
    const canvas=document.createElement('canvas');canvas.width=2048;canvas.height=2048;
    const context=canvas.getContext('2d');context.fillStyle='#203d4a';context.fillRect(0,0,2048,2048);
    const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',0.7));
    if(!blob || blob.size>128*1024) throw new Error('Native memory fixture exceeds JPEG budget');
    const bytes=Array.from(new Uint8Array(await blob.arrayBuffer()));
    const start=parseInt('abc200',36), ids=Array.from({length:41},(_,i)=>(start+i).toString(36));
    const existing=await invoke('load_thumbnail_cache');
    for(const id of ids)await invoke('record_nearby_history_item',{item:{source:'prntsc',id,sourcePageUrl:'https://prnt.sc/'+id,viewedAt:Date.now()}});
    await invoke('save_thumbnail_cache',{entries:ids.map(id=>['prntsc:'+id,bytes]),keep:[...existing.map(x=>x[0]),...ids.map(id=>'prntsc:'+id)]});
    const saved=new Set((await invoke('load_thumbnail_cache')).map(x=>x[0]));
    if(ids.some(id=>!saved.has('prntsc:'+id)))throw new Error('Native fixture was not persisted; refuse source fallback');
    await invoke('select_history_item',{index:0,source:'prntsc',id:'0'});
    window.__nearbyMemory={start,ids};
    return true;
  })()`),
    "41 native 4-megapixel fixtures are persisted before decoder stress (no source requests)",
  );
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let step = 0; step < 9; step++) {
      check(
        await evaluate(`(async () => {
        const invoke=window.__TAURI_INTERNALS__.invoke, fixture=window.__nearbyMemory;
        const sessionId='memory-${cycle}',generation=${step + 1},centerId=(fixture.start+4+${step * 4}).toString(36);
        const result=await invoke('set_nearby_window',{sessionId,generation,centerId,anchorId:fixture.ids[4]});
        const resolutions=[];
        for(let i=0;i<9;i+=2)resolutions.push(...await Promise.all(result.window.slots.slice(i,i+2).map(slot=>invoke('resolve_nearby_frame',{sessionId,generation,id:slot.id}))));
        if(resolutions.some(x=>x.state!=='available'))return false;
        const buffers=[];
        for(let i=0;i<9;i+=2)buffers.push(...await Promise.all(resolutions.slice(i,i+2).map(x=>invoke('get_nearby_thumbnail',{sessionId,thumbnailHandle:x.thumbnailHandle}))));
        return buffers.every(x=>x.byteLength>0 && x.byteLength<=128*1024);
      })()`),
        `native 4MP decode/cache cycle ${cycle + 1}, window ${step + 1}`,
      );
      samples.push(memory());
    }
    await evaluate(`window.__TAURI_INTERNALS__.invoke('close_nearby',{sessionId:'memory-${cycle}'})`);
  }
  adb("shell", "am", "send-trim-memory", "dev.randomframe.android.debug", "RUNNING_CRITICAL");
  await sleep(1000);
  samples.push(memory());
  process.stdout.write(`Android app-process memory samples: ${JSON.stringify(samples)}\n`);
  check(
    await evaluate(
      `document.querySelector('#image').naturalWidth===640 && !document.querySelector('#nearby-dialog').open`,
    ),
    "critical trim leaves the Android viewer responsive after native decoder stress",
  );
  const nativeReduced = await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
  process.stdout.write(
    `Android native reduced-motion media preference: ${nativeReduced}; renderer test uses media emulation\n`,
  );
  check(
    await evaluate(
      `(async () => {
      window.__nearbySmoke.native=false;
      if(!matchMedia('(prefers-reduced-motion: reduce)').matches)return false;
      document.querySelector('#nearby-button').click();
      document.querySelector('#nearby-next').click();document.querySelector('#nearby-previous').click();
      await new Promise(r=>setTimeout(r,1000));
      const settled=document.querySelector('#nearby-dialog').getAnimations({subtree:true}).every(x=>x.playState!=='running');
      document.querySelector('#nearby-close').click();
      return settled;
    })()`,
      true,
    ),
    "Android renderer reduced motion settles rapid navigation without repeating gallery animation (media emulated)",
  );
}
