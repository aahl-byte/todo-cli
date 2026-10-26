export function run({ attach, event, item }) {
  attach.log(`${item.id} pushed to ${event.branch}`);
}
