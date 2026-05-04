function bindFirstRevealTrigger(subscribers, reveal) {
  let revealed = false;
  const fire = () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };

  for (const subscribe of subscribers) {
    subscribe(fire);
  }
}

module.exports = { bindFirstRevealTrigger };
