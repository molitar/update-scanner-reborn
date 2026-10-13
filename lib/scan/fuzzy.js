/**
 * Check if two strings differ by more than a threshold. More efficient
 * than doing a full diff.
 *
 * @param {string} str1 - First string for comparison.
 * @param {string} str2 - Second string for comparison.
 * @param {number} changeThreshold - Number of characters that must change to
 * indicate a major change.
 *
 * @returns {boolean} Returns true if the two strings differ by more than
 * changeThreshold characters.
 */
export function isMajorChange(str1 = '', str2 = '', changeThreshold) {
  const safeStr1 = str1;
  const safeStr2 = str2;

  if (changeThreshold === 0) {
    return (safeStr1 !== safeStr2);
  }

  // Start with sliceLength=0 and slowly increase it until it reaches the
  // changeThreshold. If a match isn't found by then, it's a major change.
  // The last slice tried is exactly changeThreshold (never rounded up to the
  // next step), so thresholds such as 25, 60 or 125 mean what they say.
  let sliceLength = 0;

  while (sliceLength < changeThreshold) {
    if (sliceLength < 100) {
      sliceLength += 10;
    } else if (sliceLength < 250) {
      sliceLength += 25;
    } else if (sliceLength < 1000) {
      sliceLength += 100;
    } else {
      sliceLength += 500;
    }
    sliceLength = Math.min(sliceLength, changeThreshold);

    // If there's match with this slice length, it's not a major change.
    if (matchSlice(safeStr1, safeStr2, sliceLength)) {
      return false;
    }
  }
  return true;
}


/**
 * Measure how big the difference between two strings is: the smallest change
 * threshold (in characters) that would have ignored it. A page with this
 * threshold or higher does not report the change.
 *
 * Uses the same matching as isMajorChange, so the number can be compared
 * straight with the Change Threshold setting.
 *
 * @param {string} str1 - First string for comparison.
 * @param {string} str2 - Second string for comparison.
 * @param {number} cap - Largest size measured. Anything bigger reports
 * cap + 1 (meaning "more than cap").
 *
 * @returns {number} Size of the change in characters (0 if identical).
 */
export function changeSize(str1 = '', str2 = '', cap = 5000) {
  if (str1 === str2) {
    return 0;
  }

  // Walk up in the same steps as isMajorChange until a slice length matches.
  let previous = 0;
  let sliceLength = 0;
  while (sliceLength < cap) {
    previous = sliceLength;
    if (sliceLength < 100) {
      sliceLength += 10;
    } else if (sliceLength < 250) {
      sliceLength += 25;
    } else if (sliceLength < 1000) {
      sliceLength += 100;
    } else {
      sliceLength += 500;
    }
    sliceLength = Math.min(sliceLength, cap);

    if (matchSlice(str1, str2, sliceLength)) {
      // The match is somewhere in (previous, sliceLength]: narrow it down.
      let low = previous + 1;
      let high = sliceLength;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (matchSlice(str1, str2, middle)) {
          high = middle;
        } else {
          low = middle + 1;
        }
      }
      return high;
    }
  }
  return cap + 1;
}

/**
 * Check whether the two strings can be made to match by removing slices of
 * text.
 *
 * @param {string} str1 - First string for comparison.
 * @param {string} str2 - Second string for comparison.
 * @param {number} sliceLength - Maximum number of characters to remove when
 * looking for a match.
 *
 * @returns {boolean} Returns true if a match can be made by removing slices of
 * text.
 */
function matchSlice(str1, str2, sliceLength) {
  // If the lengths are too different, it's not a match
  if (lengthDifference(str1, str2) > sliceLength) {
    return false;
  }

  // At each difference, cut out a slice, then see if the remaining text
  // matches up.
  while (str1 !== str2) {
    const index = firstDifference(str1, str2);

    const shortest = Math.min(str1.length, str2.length);
    if (shortest < index + (sliceLength * 2)) {
      // Got to the end, it's a match
      return true;
    }

    // Slice the start off each string
    str1 = str1.slice(index + sliceLength);
    str2 = str2.slice(index + sliceLength);

    // See if there's a match within sliceLength
    for (let i = 0; ; i++) {
      // Does the match last for 10 characters?
      // First try slicing the start off str1
      if (str1.slice(i, i + 10) === str2.slice(0, 10)) {
        str1 = str1.slice(i);
        break;
      }
      // Now try slicing the start off str2
      if (str2.slice(i, i + 10) === str1.slice(0, 10)) {
        str2 = str2.slice(i);
        break;
      }

      // If we reach the threshold, it's not a match
      if (i === sliceLength) {
        return false;
      }
    }
  }
  // We've got a match
  return true;
}

/**
 * Calculate the difference in length of two strings.
 *
 * @param {string} str1 - First string for comparison.
 * @param {string} str2 - Second string for comparison.
 *
 * @returns {number} Difference in length of the two strings.
 */
function lengthDifference(str1, str2) {
  return Math.max(str1.length, str2.length) -
    Math.min(str1.length, str2.length);
}

/**
 * Find the first index where the two strings don't match.
 *
 * @param {string} str1 - First string for comparison.
 * @param {string} str2 - Second string for comparison.
 *
 * @returns {number} First index where the two strings don't match.
 */
function firstDifference(str1, str2) {
  const minlen = Math.min(str1.length, str2.length);

  for (let i = 0; i < minlen; i++) {
    if (str1[i] !== str2[i]) {
      return i;
    }
  }
  return minlen;
}
