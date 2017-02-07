'use strict'

const fs = require('fs')
const twitter = require('twitter')
const process_env = require('./keys')
const chalk = require('chalk')
// `sprintf` does not play nice with `chalk` so we cannot use at the moment
const sprintf = require("sprintf-js").sprintf

const FILE_WITH_DATA = __dirname + '/data.js'
const FILE_WITH_ANALYSIS = __dirname + '/analysis.js'
const MILLISECONDS_IN_15_MINUTES = 900000
const CURRENT_DATE = new Date().getTime()

/* Customizable constants */
const MY_TWITTER_USER_ID = 402143571  // Your Twitter user ID
const MAX_USERS_TO_DISPLAY = 5        // Number of users for forensics reporting
/* */

const Status = {
  UNFOLLOWED: 'unfollowed',
  FOLLOWED: 'followed'
}

const client = new twitter({
  consumer_key: process_env.CONSUMER_KEY,
  consumer_secret: process_env.CONSUMER_SECRET,
  access_token_key: process_env.ACCESS_TOKEN,
  access_token_secret: process_env.ACCESS_SECRET
})

const toMinutes = milliseconds_passed =>
  Math.ceil((MILLISECONDS_IN_15_MINUTES - milliseconds_passed) / 1000 / 60)

const createBadUser = () => {
  return { id: 0, name: 'null', handle: 'null', _timestamp: CURRENT_DATE }
}

function getFollowerIds (cc) {
  client.get('followers/ids', {user_id: MY_TWITTER_USER_ID}, (err, tweets, response) => {
    if (err) throw new Error(chalk.red(`followers/ids\n${JSON.stringify(err)}`))
    cc(tweets)
  })
}

function getUsersFromIds (ids, cc) {
  client.get('users/lookup', {user_id: ids}, (err, tweets, response) => {
    if (err) {
      switch (err[0].code) {
        // Bad id
        case 17:
          return cc([createBadUser()])
          break
        default:
          throw new Error(chalk.red(`users/lookup\n${JSON.stringify(err)}`))
     }
   }
    cc(tweets)
  })
}

function checkForDiffsAndRehydrate (saved_follower_list) {
  getFollowerIds((tweets) => {
    // Parse into javascript object
    const new_follower_list = JSON.parse(JSON.stringify(tweets))
    const totalFollowersCount = new_follower_list.ids.length

    // Update request count. Once we go over the 15 limit in 15 minutes, we stop
    // We only reset the 15 minutes when we reset the request count
    if (CURRENT_DATE - saved_follower_list._timestamp < MILLISECONDS_IN_15_MINUTES) {
      new_follower_list._requestCount = parseInt(saved_follower_list._requestCount) + 1
      new_follower_list._timestamp = saved_follower_list._timestamp
    } else {
      new_follower_list._requestCount = 1
      new_follower_list._timestamp = CURRENT_DATE
    }

    // @TEST (mocks new unfollower)
    // WARNING: may create duplicate
    saved_follower_list.ids.push(940666819)

    // Sort the ids so we can find diff quicker
    new_follower_list.ids.sort((a, b) => a - b)

    const diffs = disjunctiveUnion(saved_follower_list.ids, new_follower_list.ids)

    if (diffs.lost_followers.length || diffs.new_followers.length) {
      let stringified_ids = diffs.lost_followers.concat(diffs.new_followers).join(',')
      getUsersFromIds(stringified_ids, (probably_uncached_users) => {
        const decorated_users = probably_uncached_users.reduce((acc, user) => {
          acc[user.id] = {}
          acc[user.id]._timestamp = CURRENT_DATE
          acc[user.id].name = user.name
          acc[user.id].id = user.id
          acc[user.id].handle = user.screen_name
          return acc
        }, {})
        reportFollowerForensics(totalFollowersCount, diffs, decorated_users)

        // Store back in file with data
        fs.writeFile(FILE_WITH_DATA, JSON.stringify(new_follower_list), function (err) {
          if (err) throw new Error(err)
          // console.log('Successfully saved new followers list to data file!')
        })
      })
    } else {
      reportFollowerForensics(totalFollowersCount, diffs)
    }
  })
}

function readFromFile () {
  fs.readFile(FILE_WITH_DATA, 'utf8', function (err, data) {
    if (err) throw new Error(err)

    // Parse into javascript object
    const saved_follower_list = JSON.parse(data)

    // Sort the ids so we can find diff quicker
    saved_follower_list.ids.sort((a, b) => a - b)

    // If the last time we refreshed was over 15 minutes
    if (CURRENT_DATE - saved_follower_list._timestamp > MILLISECONDS_IN_15_MINUTES ||
        saved_follower_list._requestCount < 15) {
      // Potential try/catch here
      checkForDiffsAndRehydrate(saved_follower_list)
    } else {
      // Showing the analytics should take cached users from the past 3? days
      // Should also clean out very old users from cache as well
      //  - Will not be a proper cache, no need
      console.log(chalk.gray(`you must wait ${toMinutes(CURRENT_DATE - saved_follower_list._timestamp)} more minutes`))
    }
  })
}

function reportFollowerForensics (totalFollowersCount, diffs, fresh_users) {
  fs.readFile(FILE_WITH_ANALYSIS, 'utf8', function (err, data) {
    // Parse into javascript object
    const analytics = JSON.parse(data)

    console.log('')

    // width := 35
    console.log(chalk.blue('┌─────────────────────────────────┐'))
    console.log(chalk.blue('│   Twitter Followers Forensics   │'))
    console.log(chalk.blue('└─────────────────────────────────┘'))

    console.log(chalk.cyan('│         Total Followers         │'))
    console.log(chalk.cyan('└─────────────────────────────────┘'))
    console.log(chalk.cyan(`                ${totalFollowersCount}\n`))

    if (diffs.new_followers.length === 0 && diffs.lost_followers.length === 0)
      console.log(chalk.gray('        No changes detected'))

    console.log('')

    // New followers
    console.log(chalk.green('┌─────────────────────────────────┐'))
    console.log(chalk.green('│          New Followers          │'))
    console.log(chalk.green('└─────────────────────────────────┘'))

    diffs.new_followers.forEach((followerID) => {
      if (analytics.users[followerID] === undefined) {
        analytics.users[followerID] = fresh_users[followerID] || createBadUser()
      }
      analytics.users[followerID].status = Status.FOLLOWED
      console.log(chalk.bold.green(`+ ${analytics.users[followerID].name}`) +
                  chalk.bold.gray(` @${analytics.users[followerID].handle}`) +
                  chalk.bold.gray(` | ${new Date(analytics.users[followerID]._timestamp).customFormat('#h#:#mm##ampm#, #DD#/#MM#/#YYYY#')}`))
    })

    // Recent cached followers
    const cachedFollowers = Object.keys(analytics.users)
      .filter(id => analytics.users[id].status === Status.FOLLOWED &&
                    !(fresh_users && fresh_users[id]) &&
                    analytics.users[id].id !== 0)
      .sort((a, b) => b._timestamp - a._timestamp)
      .slice(0, MAX_USERS_TO_DISPLAY)
    if (cachedFollowers.length === 0 && diffs.new_followers.length === 0)
      console.log(chalk.gray('          Nobody recently'))
    cachedFollowers.forEach(id => {
      console.log(chalk.green(`  ${analytics.users[id].name}`) +
                  chalk.gray(` @${analytics.users[id].handle}`) +
                  chalk.gray(` | ${new Date(analytics.users[id]._timestamp).customFormat('#h#:#mm##ampm#, #DD#/#MM#/#YYYY#')}`))
    })

    console.log('')

    // Unfollowers
    console.log(chalk.red('┌─────────────────────────────────┐'))
    console.log(chalk.red('│           UnFollowers           │'))
    console.log(chalk.red('└─────────────────────────────────┘'))

    diffs.lost_followers.forEach((followerID) => {
      if (analytics.users[followerID] === undefined) {
        analytics.users[followerID] = fresh_users[followerID] || createBadUser()
      }
      analytics.users[followerID].status = Status.UNFOLLOWED
      console.log(chalk.bold.red(`- ${analytics.users[followerID].name}`) +
                  chalk.bold.gray(` @${analytics.users[followerID].handle}`) +
                  chalk.bold.gray(` | ${new Date(analytics.users[followerID]._timestamp).customFormat('#h#:#mm##ampm#, #DD#/#MM#/#YYYY#')}`))
    })

    // Recent cached unfollowers
    const cachedUnfollowers = Object.keys(analytics.users)
      .filter(id => analytics.users[id].status === Status.UNFOLLOWED &&
                    !(fresh_users && fresh_users[id]) &&
                    analytics.users[id].id !== 0)
      .sort((a, b) => b._timestamp - a._timestamp)
      .slice(0, MAX_USERS_TO_DISPLAY)
    if (cachedUnfollowers.length === 0 && diffs.lost_followers.length === 0)
      console.log(chalk.gray('          Nobody recently'))
    cachedUnfollowers.forEach(id => {
      console.log(chalk.red(`  ${analytics.users[id].name}`) +
                  chalk.gray(` @${analytics.users[id].handle}`) +
                  chalk.gray(` | ${new Date(analytics.users[id]._timestamp).customFormat('#h#:#mm##ampm#, #DD#/#MM#/#YYYY#')}`))
    })

    // We only want to update if there's a diff
    if (diffs) {
      fs.writeFile(FILE_WITH_ANALYSIS, JSON.stringify(analytics), function (err) {
        if (err) throw new Error(err)
        // console.log(chalk.green('Successfully saved new analytics to data file!'))
      })
    }
  })
}

function disjunctiveUnion (old_list, new_list) {
  const new_followers = []
  const lost_followers = []
  let i = 0, j = 0
  while (i < old_list.length && j < new_list.length) {
    if (old_list[i] === new_list[j]) {
      ++i
      ++j
    } else if (old_list[i] < new_list[j]) {
      lost_followers.push(old_list[i++])
    } else if (old_list[i] > new_list[j]) {
      new_followers.push(new_list[j++])
    }
  }
  while (j < new_list.length)
    new_followers.push(new_list[j++])
  while (i < old_list.length)
    lost_followers.push(old_list[i++])
  return {
    new_followers,
    lost_followers
  }
}

readFromFile()

// Date formatting from StackOverflow
//*** This code is copyright 2002-2016 by Gavin Kistner, !@phrogz.net
//*** It is covered under the license viewable at http://phrogz.net/JS/_ReuseLicense.txt
Date.prototype.customFormat = function(formatString){
  var YYYY,YY,MMMM,MMM,MM,M,DDDD,DDD,DD,D,hhhh,hhh,hh,h,mm,m,ss,s,ampm,AMPM,dMod,th;
  YY = ((YYYY=this.getFullYear())+"").slice(-2);
  MM = (M=this.getMonth()+1)<10?('0'+M):M;
  MMM = (MMMM=["January","February","March","April","May","June","July","August","September","October","November","December"][M-1]).substring(0,3);
  DD = (D=this.getDate())<10?('0'+D):D;
  DDD = (DDDD=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][this.getDay()]).substring(0,3);
  th=(D>=10&&D<=20)?'th':((dMod=D%10)==1)?'st':(dMod==2)?'nd':(dMod==3)?'rd':'th';
  formatString = formatString.replace("#YYYY#",YYYY).replace("#YY#",YY).replace("#MMMM#",MMMM).replace("#MMM#",MMM).replace("#MM#",MM).replace("#M#",M).replace("#DDDD#",DDDD).replace("#DDD#",DDD).replace("#DD#",DD).replace("#D#",D).replace("#th#",th);
  h=(hhh=this.getHours());
  if (h==0) h=24;
  if (h>12) h-=12;
  hh = h<10?('0'+h):h;
  hhhh = hhh<10?('0'+hhh):hhh;
  AMPM=(ampm=hhh<12?'am':'pm').toUpperCase();
  mm=(m=this.getMinutes())<10?('0'+m):m;
  ss=(s=this.getSeconds())<10?('0'+s):s;
  return formatString.replace("#hhhh#",hhhh).replace("#hhh#",hhh).replace("#hh#",hh).replace("#h#",h).replace("#mm#",mm).replace("#m#",m).replace("#ss#",ss).replace("#s#",s).replace("#ampm#",ampm).replace("#AMPM#",AMPM);
};
